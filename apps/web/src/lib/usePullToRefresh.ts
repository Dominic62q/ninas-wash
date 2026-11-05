import { useEffect, useRef, useState, type RefObject } from 'react';

/** How far the finger must drag, in pixels, before letting go refreshes. */
export const PULL_TRIGGER = 64;
const PULL_MAX = 96;

/**
 * Pull down from the top of a scrolling area to refresh it, like a phone app.
 * The browser's own pull-to-refresh does nothing here: the page scrolls inside a box, not the window,
 * and the installed app has no browser bar to pull on at all.
 * `pull` is how far the indicator has been dragged; `refreshing` is true while `onRefresh` runs.
 */
export function usePullToRefresh(scroller: RefObject<HTMLElement | null>, onRefresh: () => Promise<unknown>) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let startY: number | null = null;
    let distance = 0;
    let busy = false;

    const reset = () => {
      startY = null;
      distance = 0;
      setPull(0);
    };

    const onStart = (e: TouchEvent) => {
      const target = e.target as Element | null;
      // Only from the very top, with one finger, and never from inside an open sheet or a form field.
      if (busy || e.touches.length !== 1 || el.scrollTop > 0 || target?.closest('dialog, input, textarea, select')) return;
      startY = e.touches[0]!.clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = e.touches[0]!.clientY - startY;
      if (dy <= 0 || el.scrollTop > 0) {
        if (distance > 0) reset();
        else if (el.scrollTop > 0) startY = null;
        return;
      }
      distance = Math.min(dy * 0.5, PULL_MAX); // it gets heavier the further it goes
      setPull(distance);
    };

    const onEnd = async () => {
      const done = distance >= PULL_TRIGGER;
      reset();
      if (!done || busy) return;
      busy = true;
      setRefreshing(true);
      try {
        // Show the spinner for a moment even when the data comes back at once, so it is clear something happened.
        await Promise.all([refresh.current(), new Promise((r) => setTimeout(r, 700))]);
      } catch {
        // A failed refresh shows its own error where the data is, as it would on any other reload.
      } finally {
        busy = false;
        setRefreshing(false);
      }
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', reset);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', reset);
    };
  }, [scroller]);

  return { pull, refreshing };
}

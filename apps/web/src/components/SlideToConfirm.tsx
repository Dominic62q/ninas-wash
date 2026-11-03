import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

// Phone: a step that cannot be taken back (start, finish, dispatch) is confirmed by sliding, so a stray tap does nothing.
// Keyboard and screen readers confirm with Enter, Space or the right arrow on the handle.

const HANDLE = 46;
const PAD = 4;
const FAR_ENOUGH = 0.85;

export function SlideToConfirm({ label, busy, disabled, onConfirm }: { label: string; busy?: boolean; disabled?: boolean; onConfirm: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ from: number; max: number } | null>(null);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const locked = !!busy || !!disabled;

  useEffect(() => {
    if (!busy) setX(0); // a failed step slides back
  }, [busy]);

  function down(e: PointerEvent<HTMLButtonElement>) {
    if (locked || !track.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { from: e.clientX - x, max: track.current.clientWidth - HANDLE - PAD * 2 };
    setDragging(true);
  }

  function move(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (d) setX(Math.min(Math.max(e.clientX - d.from, 0), d.max));
  }

  function up() {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    if (x >= d.max * FAR_ENOUGH) {
      setX(d.max);
      onConfirm();
    } else {
      setX(0);
    }
  }

  function key(e: KeyboardEvent<HTMLButtonElement>) {
    if (locked) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (track.current) setX(track.current.clientWidth - HANDLE - PAD * 2);
      onConfirm();
    }
  }

  const fade = busy ? 0.9 : Math.max(0, 1 - x / 90);

  return (
    <div
      ref={track}
      className={`relative h-[54px] flex-1 select-none overflow-hidden rounded-xl bg-blue ${disabled ? 'opacity-50' : ''}`}
      style={{ touchAction: 'pan-y' }}
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-white/20" style={{ width: x + HANDLE + PAD * 2, transition: dragging ? 'none' : 'width .2s ease' }} />
      <span aria-hidden="true" className="absolute inset-0 grid place-items-center pl-10 text-[15px] font-bold text-white" style={{ opacity: fade }}>
        {busy ? 'Working…' : label}
      </span>
      <button
        type="button"
        aria-label={label}
        disabled={locked}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        className="absolute top-1 grid h-[46px] w-[46px] cursor-grab place-items-center rounded-[9px] bg-surface text-blue-d active:cursor-grabbing"
        style={{ left: PAD, transform: `translateX(${x}px)`, transition: dragging ? 'none' : 'transform .2s ease', touchAction: 'none' }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 5 7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}

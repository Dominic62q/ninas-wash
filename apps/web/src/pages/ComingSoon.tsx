import { useLocation } from 'react-router';
import { NAV } from '../lib/nav';

/** Stands in for a screen that a later phase builds, so the menu already works end to end. */
export function ComingSoon() {
  const { pathname } = useLocation();
  const item = NAV.find((i) => i.path === pathname);
  return (
    <section className="border border-line bg-surface px-5 py-8 max-lg:overflow-hidden max-lg:rounded-[14px] max-lg:border-0 max-lg:shadow-card">
      <p className="text-ink-2">{item ? `Coming in Phase ${item.phase}.` : 'Not built yet.'}</p>
    </section>
  );
}

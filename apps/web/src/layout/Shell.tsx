import { useEffect, useRef, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { ProfileMenu } from '../components/ProfileMenu';
import { useAuth } from '../lib/auth';
import { NAV, meFor, moneyFor, navFor, type NavItem } from '../lib/nav';

const TODAY = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

function Wordmark() {
  return (
    <div className="flex flex-col leading-none">
      <span className="brand text-[25px] text-white">NIINAS</span>
      <span className="brand pl-3.5 text-[15px] font-semibold tracking-[0.14em] text-white">WASH</span>
    </div>
  );
}

/** The desktop side rail: navy, flat, with a slanted red tick on the current page. */
function SideRail({ items }: { items: NavItem[] }) {
  const groups = ['Daily', 'Money', 'Setup'] as const;

  return (
    <aside className="sticky top-0 hidden h-screen w-60 flex-none flex-col bg-rail px-4 py-5 lg:flex">
      <div className="px-3 pb-6">
        <Wordmark />
      </div>
      {/* The negative margin lets the red tick sit at the rail's edge without being clipped by the scroll area. */}
      {/* On a short window the list still scrolls, but without the browser's bright scrollbar sitting on the navy. */}
      <nav aria-label="Main" className="-mx-4 flex flex-1 flex-col overflow-y-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {groups.map((group) => {
          const inGroup = items.filter((i) => i.group === group);
          if (inGroup.length === 0) return null;
          return (
            <div key={group} role="group" aria-label={group} className="mt-3 flex flex-col gap-0.5 border-t border-white/10 pt-3 first:mt-0 first:border-t-0 first:pt-0">
              {inGroup.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  className={({ isActive }) =>
                    `group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium no-underline transition-colors ${
                      isActive ? 'bg-white/[0.14] text-white' : 'text-[#b9c7e0] hover:bg-white/5 hover:text-white'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span aria-hidden="true" className="absolute -left-4 top-1/2 h-5 w-1 -translate-y-1/2 -skew-x-[14deg] bg-red" />
                      )}
                      <span className={`flex transition-colors ${isActive ? 'text-white' : 'text-[#8fa3c7] group-hover:text-white'}`}>
                        <Icon name={item.icon} size={18} />
                      </span>
                      {item.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
      <ProfileMenu variant="rail" />
    </aside>
  );
}

function TabIcon({ children, filled }: { children: ReactNode; filled?: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * Phone: Home, Jobs, a blue + for a new job, Money and Me. Everything else is listed under Money and Me.
 * It is the last row of a screen-high column, not a fixed bar: the phone's address bar and toolbars sliding
 * in and out can never clip it, and the page scrolls above it.
 */
function TabBar({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation();
  const hasHome = items.some((i) => i.path === '/');
  const hasJobs = items.some((i) => i.path === '/jobs');
  const money = moneyFor(items);
  const meActive = pathname === '/me' || meFor(items).some((i) => pathname.startsWith(i.path));
  const moneyActive = pathname === '/money' || money.some((i) => pathname.startsWith(i.path));
  const jobsActive = pathname.startsWith('/jobs') && pathname !== '/jobs/new';
  const tab = (active: boolean) =>
    `flex min-h-[54px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold no-underline ${active ? 'text-blue-d' : 'text-ink-3'}`;

  return (
    <nav aria-label="Main" className="relative z-20 flex flex-none items-center border-t border-line bg-surface px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 lg:hidden">
      {hasHome && (
        <NavLink to="/" end className={({ isActive }) => tab(isActive)}>
          {({ isActive }) => (
            <>
              <TabIcon filled={isActive}>
                <path d="M12 3.2 3 10.6V20a1 1 0 0 0 1 1h5v-6h6v6h5a1 1 0 0 0 1-1v-9.4z" />
              </TabIcon>
              Home
            </>
          )}
        </NavLink>
      )}
      {hasJobs && (
        <>
          <NavLink to="/jobs" className={() => tab(jobsActive)}>
            <TabIcon>
              <path d="M5 16v-5l1.6-4.4A1.5 1.5 0 0 1 8 5.6h8a1.5 1.5 0 0 1 1.4 1L19 11v5" />
              <path d="M3.5 16h17v3h-17z" />
              <path d="M7 13.5h.01M17 13.5h.01" />
            </TabIcon>
            Jobs
          </NavLink>
          <NavLink
            to="/jobs/new"
            aria-label="New job"
            className="mx-2.5 grid h-[46px] w-[46px] flex-none place-items-center rounded-xl bg-blue text-white no-underline active:scale-95"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </NavLink>
        </>
      )}
      {money.length > 0 && (
        <NavLink to="/money" className={() => tab(moneyActive)}>
          <TabIcon>
            <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
            <circle cx="12" cy="12" r="2.6" />
            <path d="M6 12h.01M18 12h.01" />
          </TabIcon>
          Money
        </NavLink>
      )}
      <NavLink to="/me" className={() => tab(meActive)}>
        <TabIcon>
          <circle cx="12" cy="8" r="4" />
          <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
        </TabIcon>
        Me
      </NavLink>
    </nav>
  );
}

export function Shell() {
  const { can } = useAuth();
  const items = navFor(can);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = NAV.find((i) => (i.path === '/' ? pathname === '/' : pathname.startsWith(i.path)));
  /** Pages opened from the board get a back arrow in the header instead of a link of their own. */
  const sub = pathname.startsWith('/jobs/') ? { back: '/jobs', title: pathname === '/jobs/new' ? 'New job' : 'Job' } : null;
  const title = sub?.title ?? current?.label ?? (pathname === '/money' ? 'Money' : pathname === '/me' ? 'Me' : 'Niinas Wash');
  const scroller = useRef<HTMLDivElement>(null);
  // A new screen starts at the top, as a page would. (Back keeps the list's own filters and dates, not its scroll.)
  useEffect(() => {
    scroller.current?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, [pathname]);
  const goBack = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate(sub?.back ?? '/')); // keeps the list's dates and filters

  return (
    // Phone: exactly one screen tall (dvh follows the address bar), so only the page scrolls, never the whole window.
    <div className="flex min-h-screen max-lg:h-[100dvh] max-lg:min-h-0 max-lg:flex-col max-lg:overflow-hidden">
      <SideRail items={items} />
      <div ref={scroller} className="app-scroll flex min-w-0 flex-1 flex-col max-lg:min-h-0 max-lg:overflow-y-auto max-lg:overscroll-y-contain">
        {/* Computer: a white bar with the page name and today's date. z-30 keeps toggles inside the page from sliding over it. */}
        <header className="sticky top-0 z-30 hidden items-center gap-4 border-b border-line bg-surface px-7 py-3.5 text-navy lg:flex">
          {sub && (
            <button type="button" aria-label="Back to jobs" onClick={goBack} className="tap -ml-3 grid h-11 w-11 place-items-center px-0 text-2xl leading-none text-blue-d">
              ←
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="display truncate text-[30px] leading-none">{title}</h1>
            <p className="mt-1 text-sm text-ink-3">{TODAY()}</p>
          </div>
        </header>

        {/* Phone: the page name on the grey ground. Home draws its own greeting instead. */}
        {pathname !== '/' && (
          <div className="flex items-center gap-3 px-4 pb-1 pt-[max(1.25rem,env(safe-area-inset-top))] lg:hidden">
            {sub && (
              <button
                type="button"
                aria-label="Back to jobs"
                onClick={goBack}
                className="grid h-11 w-11 flex-none cursor-pointer place-items-center rounded-xl bg-surface text-navy shadow-card active:scale-95"
              >
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
            )}
            <h1 className="display min-w-0 flex-1 truncate text-[26px] leading-[1.1] text-navy">{title}</h1>
          </div>
        )}

        <main className="flex flex-1 flex-col gap-4 px-4 py-4 lg:gap-5 lg:px-7 lg:py-5">
          <Outlet />
        </main>
      </div>
      {/* A job's own pages (new job, one job) have a bar of their own at the bottom of the page instead. */}
      {!sub && <TabBar items={items} />}
    </div>
  );
}

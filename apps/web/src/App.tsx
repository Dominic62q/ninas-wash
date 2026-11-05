import type { ReactNode } from 'react';
import type { Permission } from '@niinas/shared';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { ConnectionBanner } from './components/ConnectionBanner';
import { Shell } from './layout/Shell';
import { useAuth } from './lib/auth';
import { NAV } from './lib/nav';
import { useThemeSync } from './lib/theme';
import { ComingSoon } from './pages/ComingSoon';
import { ChangePassword } from './pages/ChangePassword';
import { ActivityLog } from './pages/ActivityLog';
import { Commissions } from './pages/Commissions';
import { Customers } from './pages/Customers';
import { DailyClose } from './pages/DailyClose';
import { Dashboard } from './pages/Dashboard';
import { Expenses } from './pages/Expenses';
import { JobDetail } from './pages/JobDetail';
import { Jobs } from './pages/Jobs';
import { Me } from './pages/Me';
import { Money } from './pages/Money';
import { NewJob } from './pages/NewJob';
import { Reports } from './pages/Reports';
import { Services } from './pages/Services';
import { Texts } from './pages/Texts';
import { SignIn } from './pages/SignIn';
import { Staff } from './pages/Staff';
import { Tips } from './pages/Tips';

/** Everything inside needs a signed-in person. Anyone else is sent to the sign-in page. */
function RequireSignIn() {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  if (loading) return <div className="grid min-h-screen place-items-center text-ink-3">Loading…</div>;
  if (!user) return <Navigate to="/sign-in" replace />;
  // A temporary password only gets someone as far as choosing their own.
  if (user.mustChangePassword && pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  return <Outlet />;
}

/** The screens built so far. The rest show a "coming in Phase N" note. */
const SCREENS: Record<string, ReactNode> = {
  '/jobs': <Jobs />,
  '/customers': <Customers />,
  '/services': <Services />,
  '/staff': <Staff />,
  '/commissions': <Commissions />,
  '/tips': <Tips />,
  '/expenses': <Expenses />,
  '/daily-close': <DailyClose />,
  '/reports': <Reports />,
  '/sms': <Texts />,
  '/activity': <ActivityLog />,
};

/** A page that needs a permission. Without it, the person lands on the dashboard instead. */
function RequirePermission({ item }: { item: (typeof NAV)[number] }) {
  const { can } = useAuth();
  if (item.needs && !can(item.needs)) return <Navigate to="/" replace />;
  return <>{SCREENS[item.path] ?? <ComingSoon />}</>;
}

/** A page that is not in the menu but still needs a permission. */
function RequireCan({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? <>{children}</> : <Navigate to="/" replace />;
}

export function App() {
  useThemeSync();
  return (
    <BrowserRouter>
      <ConnectionBanner />
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route element={<RequireSignIn />}>
          <Route path="/change-password" element={<ChangePassword />} />
          <Route element={<Shell />}>
            <Route index element={<Dashboard />} />
            <Route path="/more" element={<Navigate to="/me" replace />} />
            <Route path="/me" element={<Me />} />
            <Route path="/money" element={<Money />} />
            <Route path="/jobs/new" element={<RequireCan permission="job.create"><NewJob /></RequireCan>} />
            <Route path="/jobs/:id" element={<RequireCan permission="job.create"><JobDetail /></RequireCan>} />
            {NAV.filter((i) => i.path !== '/').map((item) => (
              <Route key={item.path} path={item.path} element={<RequirePermission item={item} />} />
            ))}
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

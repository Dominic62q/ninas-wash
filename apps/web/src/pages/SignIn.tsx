import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useNavigate } from 'react-router';
import { loginInput, type LoginInput } from '@niinas/shared';
import logo from '../assets/niinas-logo.jpg';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

/** The blue panel with the red sweep, as drawn in the approved screens. */
function Sweep({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 720 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true" className={className}>
      <path
        d="M 700 90 C 240 20 -40 360 70 690 C 140 900 380 980 640 930"
        fill="none"
        stroke="#DA000C"
        strokeWidth="34"
        strokeLinecap="round"
      />
      <path
        d="M 700 160 C 300 110 70 400 150 670 C 205 850 400 920 620 880"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.22"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The phone header's sweep sits on the right, clear of the wordmark. */
function PhoneSweep() {
  return (
    <svg viewBox="0 0 390 340" preserveAspectRatio="xMaxYMid slice" aria-hidden="true" className="absolute inset-0 h-full w-full">
      <path
        d="M 376 -24 C 272 24 240 150 310 244 C 336 280 372 298 416 294"
        fill="none"
        stroke="#DA000C"
        strokeWidth="22"
        strokeLinecap="round"
      />
      <path d="M 376 28 C 300 70 286 150 336 214" fill="none" stroke="#FFFFFF" strokeOpacity="0.22" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** The slanted white N with the red bar underneath: the app icon, drawn in code so it stays sharp. */
function Mark({ size, className }: { size: number; className?: string }) {
  return (
    <svg viewBox="100 130 295 296" width={size} height={size} aria-hidden="true" className={className}>
      <path d="M175 141 L239 141 L296 275 L325 141 L388 141 L337 371 L274 371 L216 236 L188 371 L125 371 Z" fill="#fff" />
      <path d="M111 396 L341 396 L335 418 L105 418 Z" fill="#DA000C" />
    </svg>
  );
}

/** How long the phone's welcome screen stays up after a good sign in. */
const WELCOME_MS = 1900;

export function SignIn() {
  const { user, loading, login, offline } = useAuth();
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [welcome, setWelcome] = useState(false);
  /** True from the moment the form is sent, so a good sign in shows the welcome screen instead of jumping straight home. */
  const signingIn = useRef(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginInput), defaultValues: { username: '', password: '' } });

  useEffect(() => {
    if (!welcome) return;
    // Computers and people who asked for less motion skip the welcome screen.
    const skip = window.matchMedia('(min-width: 1024px), (prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(() => navigate('/', { replace: true }), skip ? 0 : WELCOME_MS);
    return () => clearTimeout(t);
  }, [welcome, navigate]);

  if (!loading && user && !signingIn.current) return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    signingIn.current = true;
    try {
      await login(values);
      setWelcome(true);
    } catch (e) {
      signingIn.current = false;
      setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    }
  });

  const message = formError ?? (offline ? 'Cannot reach the server. Check your connection.' : null);
  const busy = isSubmitting || welcome;

  return (
    <div className="grid min-h-screen bg-surface lg:grid-cols-2">
      {/* Phone: a blue header with the mark and wordmark, and the form on a white sheet over its lower edge. */}
      <div className="relative h-[300px] overflow-hidden bg-blue pt-[env(safe-area-inset-top)] lg:hidden">
        <PhoneSweep />
        <div className="relative flex h-full flex-col justify-end px-6 pb-12 text-white">
          <Mark size={60} />
          <span className="brand mt-4 text-[34px] leading-none">NIINAS WASH</span>
          <span className="mt-2 text-sm font-semibold">Every cedi. Every wash.</span>
        </div>
      </div>

      <div className="relative -mt-[18px] flex items-start justify-center rounded-t-[18px] bg-surface px-[22px] pb-8 pt-[26px] lg:mt-0 lg:items-center lg:rounded-none lg:p-12">
        <div className="flex w-full max-w-[400px] flex-col gap-5 lg:gap-7">
          <img
            src={logo}
            alt="Niinas Wash: interior, exterior, deep clean"
            width={320}
            className="-ml-2 hidden h-auto w-[320px] lg:block"
          />
          <div className="flex flex-col gap-1.5">
            <h1 className="display text-[24px] leading-[1.1] text-navy lg:text-[32px]">Sign in</h1>
          </div>

          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
            <div className="field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                className="input max-lg:h-[50px]"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={errors.username ? 'true' : undefined}
                aria-describedby={errors.username ? 'username-error' : undefined}
                {...register('username')}
              />
              {errors.username && (
                <p id="username-error" className="text-sm font-semibold text-red-d">
                  {errors.username.message}
                </p>
              )}
            </div>

            <div className="field">
              <div className="flex items-center">
                <label htmlFor="password" className="flex-1">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-pressed={showPassword}
                  className="tap -my-3 mr-[-2px] text-[13px] text-blue-d"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              <input
                id="password"
                className="input max-lg:h-[50px]"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                aria-invalid={errors.password ? 'true' : undefined}
                aria-describedby={errors.password ? 'password-error' : undefined}
                {...register('password')}
              />
              {errors.password && (
                <p id="password-error" className="text-sm font-semibold text-red-d">
                  {errors.password.message}
                </p>
              )}
            </div>

            {message && (
              <p role="alert" className="rounded-md border border-red/30 bg-red-50 px-3.5 py-2.5 text-sm font-semibold text-red-d">
                {message}
              </p>
            )}

            <button type="submit" disabled={busy} className="btn btn-primary mt-1 w-full gap-2.5 text-base max-lg:h-[50px] lg:h-12">
              {busy && <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-[3px] border-white/40 border-t-white" />}
              {busy ? 'Signing in' : 'Sign in'}
            </button>
          </form>

          <p className="text-[13px] text-ink-3">Forgot your password? Ask a manager.</p>
        </div>
      </div>

      {/* Desktop: the big blue panel. */}
      <div className="relative hidden flex-col justify-end overflow-hidden bg-blue p-16 lg:flex">
        <Sweep className="absolute inset-0 h-full w-full" />
        <div className="relative flex max-w-[440px] flex-col gap-4">
          <p className="display text-[56px] leading-[1.02] text-white">
            Every cedi.
            <br />
            Every wash.
            <br />
            Accounted for.
          </p>
          <p className="max-w-[380px] text-base leading-normal text-white">
            Record jobs, take payments and pay attendants, with a clear trail behind every number.
          </p>
        </div>
      </div>

      {/* Phone: after a good sign in, the blue opens up from the button with a welcome, then Home takes over. */}
      {welcome && user && (
        <div role="status" aria-live="polite" className="welcome fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-blue text-center text-white lg:hidden">
          <svg viewBox="0 0 390 340" preserveAspectRatio="xMaxYMin slice" aria-hidden="true" className="absolute left-0 top-0 h-[340px] w-full">
            <path d="M 376 -24 C 272 24 240 150 310 244 C 336 280 372 298 416 294" fill="none" stroke="#DA000C" strokeWidth="22" strokeLinecap="round" />
          </svg>
          <Mark size={84} className="welcome-logo relative" />
          <p className="welcome-hi relative mt-[18px] text-[22px] font-bold">Welcome back, {user.name.split(' ')[0]}</p>
          <p className="welcome-sub relative mt-1.5 text-[14.5px] text-white/85">Opening today’s board</p>
          <div className="welcome-track relative mt-7 h-[3px] w-[150px] overflow-hidden bg-white/30">
            <i className="welcome-fill block h-full bg-surface" />
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { applyCloudLoginWindowSize, type CloudLoginMode } from '@/features/cloud/loginWindow';
import { CLOUD_LOGIN_WINDOW_DRAG_STYLE } from '@/app/windowDrag';
import { CloudAuthError, type CloudOAuthProvider } from '@/features/cloud/authClient';
import {
  readLoginModePreference,
  writeLoginModePreference,
} from '@/features/cloud/loginModePreference';
import {
  generatedAvatarPreviewUrl,
  HUMAN_CANONICAL_AVATAR_STYLE,
  newCanonicalAvatarSeed,
} from '@/features/cloud/canonicalAvatar';

import { GitHubMark, GoogleMark } from './CloudLoginMarks';
import { cloudLoginErrorMessage, PASSWORD_MIN_LENGTH } from './cloudLoginMessages';
import { CloudSignupAvatarPicker } from './CloudSignupAvatarPicker';

// Type scale — one place, applied everywhere. The whole page reads from these.
const TYPE_DISPLAY = 'text-[34px] leading-[1.1] font-bold tracking-[-0.025em]';
const TYPE_LABEL = 'text-[12px] font-medium tracking-[-0.005em]';
const TYPE_INPUT = 'text-[15px] font-medium tracking-[-0.005em]';
const TYPE_ACTION = 'text-[13px] font-semibold tracking-[-0.005em]';
const TYPE_TAB = 'text-[13px] font-semibold tracking-[-0.005em]';
const TYPE_HINT = 'text-[12px] font-medium tracking-[-0.005em]';
const TYPE_DIVIDER = 'text-[10px] font-semibold uppercase tracking-[0.18em]';
const TYPE_TITLEBAR = 'text-[12px] font-semibold tracking-[0.02em]';

// Color is driven by the shared theme tokens (theme-tokens.css). The page is
// rendered inside a `.kordi-app` root (CloudGateShell), so
// `.kordi-app.theme-light` and `.kordi-app.theme-dark` cascades apply
// automatically. Decorative layers (page bg gradient, paper grain) are themed
// via `theme-overrides.css` keyed off the same class names used below.
const INK = 'text-foreground';
const INK_MUTED = 'text-muted-foreground';
const INK_SUBTLE = 'text-[var(--utility-meta-text)]';
const PAPER_RAISED = 'bg-[var(--app-cloud-login-raised-bg)]';
const PAPER_SUNK = 'bg-[var(--app-cloud-login-sunk-bg)]';
const PAPER_INPUT = 'bg-[var(--app-cloud-login-input-bg)]';
const BORDER_SOFT = 'border-[var(--app-cloud-login-border)]';
const BORDER_INNER = 'border-[var(--app-cloud-login-inner-border)]';
const FOCUS_RING = 'focus:border-[var(--app-cloud-login-focus-border)] focus:shadow-[0_0_0_3px_var(--app-cloud-login-focus-ring)]';
const INPUT_BASE_CLASS = [
  'app-cloud-login-input h-12 rounded-full border px-5 outline-none transition',
  'focus:bg-[var(--app-cloud-login-input-focus-bg)]',
].join(' ');
const INPUT_ERROR_CLASS = [
  'border-[var(--app-cloud-login-danger-border)]',
  'focus:border-[var(--app-cloud-login-danger-border-strong)]',
  'focus:shadow-[0_0_0_3px_var(--app-cloud-login-danger-ring)]',
].join(' ');
const INPUT_HINT_CLASS = [
  'focus:border-[var(--app-cloud-login-hint-border)]',
  'focus:shadow-[0_0_0_3px_var(--app-cloud-login-hint-ring)]',
].join(' ');
const SMALL_FOCUS_RING = 'focus-visible:ring-2 focus-visible:ring-[var(--app-cloud-login-focus-ring-visible)]';

type SocialProvider = { id: 'google' | 'github'; label: string; Mark: ComponentType };
const SOCIAL_LOGIN_PROVIDERS: ReadonlyArray<SocialProvider> = [
  { id: 'google', label: 'Google', Mark: GoogleMark },
  { id: 'github', label: 'GitHub', Mark: GitHubMark },
];
const ALL_SOCIAL_PROVIDER_IDS: ReadonlyArray<CloudOAuthProvider> = SOCIAL_LOGIN_PROVIDERS.map(
  (provider) => provider.id,
);

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type CloudFieldValidation = 'invalid' | 'hint' | undefined;

function CloudField({
  label,
  ariaLabel,
  type,
  autoComplete,
  placeholder,
  value,
  onChange,
  validation,
  hint,
  disabled,
}: {
  label?: string;
  ariaLabel?: string;
  type: string;
  autoComplete: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
  validation?: CloudFieldValidation;
  hint?: string;
  disabled?: boolean;
}) {
  const baseInput = `${INPUT_BASE_CLASS} ${PAPER_INPUT} ${TYPE_INPUT} ${INK}`;
  const tone =
    validation === 'invalid'
      ? INPUT_ERROR_CLASS
      : validation === 'hint'
      ? `${BORDER_SOFT} ${INPUT_HINT_CLASS}`
      : `${BORDER_SOFT} ${FOCUS_RING}`;
  return (
    <label className={`grid gap-1.5 ${TYPE_LABEL} ${INK_MUTED}`}>
      {label ? <span>{label}</span> : null}
      <input
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-label={ariaLabel ?? label}
        aria-invalid={validation === 'invalid' || undefined}
        disabled={disabled}
        className={`${baseInput} ${tone}`}
      />
      {hint ? (
        <span
          className={`${TYPE_HINT} normal-case tracking-normal ${
            validation === 'invalid'
              ? 'text-[var(--app-cloud-login-danger-text)]'
              : 'text-[var(--app-cloud-login-hint-text)]'
          }`}
        >
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export type CloudLoginPageProps = {
  initialMode?: CloudLoginMode;
  onSignIn?: (email: string, password: string) => Promise<void>;
  onSignUp?: (input: {
    email: string;
    password: string;
    displayName?: string;
    avatarSeed: string;
  }) => Promise<void>;
  onSocialSignIn?: (provider: CloudOAuthProvider) => Promise<void>;
  showDebugAuthDiagnostics?: boolean;
};

const noopSignIn = async () => {
  /* preview-only fallback for tests / browser */
};
const noopSignUp = noopSignIn;

export function CloudLoginPage({
  initialMode = 'login',
  onSignIn = noopSignIn,
  onSignUp = noopSignUp,
  onSocialSignIn,
  showDebugAuthDiagnostics = false,
}: CloudLoginPageProps = {}) {
  const [mode, setMode] = useState<CloudLoginMode>(() => readLoginModePreference() ?? initialMode);
  const [avatarSeed, setAvatarSeed] = useState(() => newCanonicalAvatarSeed());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [socialProvider, setSocialProvider] = useState<CloudOAuthProvider | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isSignup = mode === 'signup';
  const enabledSocialProviders = onSocialSignIn ? ALL_SOCIAL_PROVIDER_IDS : [];
  const generatedSignupAvatarUrl = generatedAvatarPreviewUrl(
    HUMAN_CANONICAL_AVATAR_STYLE,
    avatarSeed,
  ) ?? '';

  useEffect(() => {
    void applyCloudLoginWindowSize(mode);
    writeLoginModePreference(mode);
  }, [mode]);

  function regenerateAvatar() {
    setAvatarSeed(newCanonicalAvatarSeed());
  }

  const emailInvalid = email.length > 0 && !EMAIL_PATTERN.test(email);
  const passwordTooShort = isSignup && password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const passwordMismatch = isSignup && confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (!EMAIL_PATTERN.test(email)) return false;
    if (password.length < PASSWORD_MIN_LENGTH) return false;
    if (isSignup && password !== confirmPassword) return false;
    return true;
  }, [confirmPassword, email, isSignup, password, submitting]);

  const submitLabel = isSignup
    ? submitting
      ? 'Creating account…'
      : 'Create account'
    : submitting
      ? 'Signing in…'
      : 'Continue';

  async function handleSocialSignIn(provider: CloudOAuthProvider) {
    if (!onSocialSignIn || socialProvider || !enabledSocialProviders.includes(provider)) return;
    setSocialProvider(provider);
    setSubmitError(null);
    try {
      await onSocialSignIn(provider);
    } catch (caught) {
      if (caught instanceof CloudAuthError) {
        setSubmitError(cloudLoginErrorMessage(caught, showDebugAuthDiagnostics));
      } else if (caught instanceof Error) {
        setSubmitError(caught.message);
      } else {
        setSubmitError('Could not start social sign-in.');
      }
      setSocialProvider(null);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (isSignup) {
        const trimmedName = displayName.trim();
        await onSignUp({
          email,
          password,
          displayName: trimmedName.length > 0 ? trimmedName : undefined,
          avatarSeed,
        });
      } else {
        await onSignIn(email, password);
      }
    } catch (caught) {
      if (caught instanceof CloudAuthError) {
        setSubmitError(cloudLoginErrorMessage(caught, showDebugAuthDiagnostics));
      } else if (caught instanceof Error) {
        setSubmitError(caught.message);
      } else {
        setSubmitError('Something went wrong. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const tabBaseClass = `relative z-10 rounded-full px-3 py-1.5 ${TYPE_TAB} transition`;
  const tabActiveText = INK;
  const tabInactiveText = `${INK_MUTED} hover:${INK}`;
  const modeKey = isSignup ? 'signup' : 'login';

  return (
    <div
      className={`app-cloud-login-page fixed inset-0 z-[100] grid place-items-center overflow-hidden px-5 py-14 ${INK}`}
      style={{ WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="app-cloud-login-accents pointer-events-none absolute inset-0" />
      <div className="app-cloud-login-grain pointer-events-none absolute inset-0" />

      <div
        className="absolute"
        style={CLOUD_LOGIN_WINDOW_DRAG_STYLE}
        data-tauri-drag-region="true"
        aria-hidden="true"
      />
      <div className={`pointer-events-none absolute left-0 right-0 top-3 text-center ${TYPE_TITLEBAR} ${INK_SUBTLE}`}>
        Kordi
      </div>

      <main className="app-cloud-login-panel relative w-full max-w-[440px] px-6">
        <div
          data-cloud-login-mode-copy={modeKey}
          className="app-cloud-login-mode-copy grid justify-items-center text-center"
        >
          <h1 className={`${TYPE_DISPLAY} ${INK}`}>
            {isSignup ? 'Create your account' : 'Welcome to Kordi'}
          </h1>
          <p className={`mt-2 ${TYPE_HINT} normal-case tracking-normal ${INK_MUTED}`}>
            {isSignup ? 'Sign up for Next-generation Supercollaboration' : 'Building Next-generation Supercollaboration'}
          </p>
        </div>

        <div className="mt-7 flex items-center justify-center gap-6">
          {SOCIAL_LOGIN_PROVIDERS.map((provider) => {
            const isAvailable = Boolean(
              onSocialSignIn && enabledSocialProviders.includes(provider.id),
            );
            const accessibleLabel = isAvailable
              ? `Continue with ${provider.label}`
              : `${provider.label} sign-in unavailable; use email and password`;
            return (
              <button
                key={provider.id}
                type="button"
                disabled={!isAvailable || Boolean(socialProvider)}
                title={accessibleLabel}
                aria-label={accessibleLabel}
                data-provider={provider.id}
                data-provider-available={isAvailable ? 'true' : 'false'}
                onClick={() => void handleSocialSignIn(provider.id)}
                className={[
                  'app-cloud-login-social-pill flex h-10 w-10 items-center justify-center rounded-full transition duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-cloud-login-focus-ring-visible)]',
                  isAvailable
                    ? 'hover:scale-105 disabled:cursor-wait disabled:opacity-55'
                    : 'cursor-not-allowed opacity-35 grayscale',
                  INK,
                ].join(' ')}
              >
                <provider.Mark />
                {socialProvider === provider.id ? <span className="sr-only">Starting…</span> : null}
              </button>
            );
          })}
        </div>

        <div className={`mt-5 flex items-center gap-3 ${TYPE_DIVIDER} ${INK_SUBTLE}`}>
          <div className="h-px flex-1 bg-[var(--app-cloud-login-divider)]" />
          {onSocialSignIn ? 'or' : 'Email and password'}
          <div className="h-px flex-1 bg-[var(--app-cloud-login-divider)]" />
        </div>

        <div className={`relative mt-5 grid grid-cols-2 gap-1 rounded-full border ${BORDER_INNER} ${PAPER_SUNK} p-1`}>
          <span
            aria-hidden="true"
            className={[
              'app-cloud-login-tab-pill pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] rounded-full',
              'transition-transform duration-200 ease-out',
              PAPER_RAISED,
            ].join(' ')}
            style={{ transform: isSignup ? 'translateX(calc(100% + 0.25rem))' : 'translateX(0)' }}
          />
          <button
            type="button"
            onClick={() => setMode('login')}
            aria-pressed={!isSignup}
            className={`${tabBaseClass} ${!isSignup ? tabActiveText : tabInactiveText}`}
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => setMode('signup')}
            aria-pressed={isSignup}
            className={`${tabBaseClass} ${isSignup ? tabActiveText : tabInactiveText}`}
          >
            Sign up
          </button>
        </div>
        <form
          data-cloud-login-mode-form={modeKey}
          className="app-cloud-login-form mt-5 grid gap-3.5"
          onSubmit={handleSubmit}
        >
          <div
            className="app-cloud-login-signup-section"
            data-cloud-login-signup-section={isSignup ? 'open' : 'closed'}
            aria-hidden={!isSignup}
          >
            <div className="app-cloud-login-signup-field grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
              <CloudSignupAvatarPicker
                generatedImageUrl={generatedSignupAvatarUrl}
                onRegenerate={regenerateAvatar}
                disabled={!isSignup}
              />
              <CloudField
                ariaLabel="Display name"
                type="text"
                autoComplete="name"
                placeholder="Display name"
                value={displayName}
                onChange={setDisplayName}
                disabled={!isSignup}
              />
            </div>
          </div>
          <CloudField
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={setEmail}
            validation={emailInvalid ? 'invalid' : undefined}
            hint={emailInvalid ? 'Use a full email like name@example.com.' : undefined}
          />
          <CloudField
            label="Password"
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            placeholder="••••••••"
            value={password}
            onChange={setPassword}
            validation={passwordTooShort ? 'hint' : undefined}
            hint={passwordTooShort ? `At least ${PASSWORD_MIN_LENGTH} characters.` : undefined}
          />
          <div
            className="app-cloud-login-signup-section"
            data-cloud-login-signup-section={isSignup ? 'open' : 'closed'}
            aria-hidden={!isSignup}
          >
            <div className="app-cloud-login-signup-field">
              <CloudField
                label="Confirm Password"
                type="password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={setConfirmPassword}
                validation={passwordMismatch ? 'invalid' : undefined}
                hint={passwordMismatch ? 'Passwords do not match.' : undefined}
                disabled={!isSignup}
              />
            </div>
          </div>
          {submitError ? (
            <div
              role="alert"
              className={[
                'app-cloud-login-error rounded-[14px] border px-4 py-2.5 normal-case tracking-normal',
                TYPE_HINT,
              ].join(' ')}
            >
              {submitError}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={!canSubmit}
            aria-busy={submitting || undefined}
            aria-label={isSignup ? 'Create account' : 'Sign in'}
            className={[
              'app-cloud-login-submit mt-1 h-12 rounded-full border transition',
              'disabled:cursor-not-allowed disabled:opacity-70',
              TYPE_ACTION,
            ].join(' ')}
          >
            {submitLabel}
          </button>
        </form>
      </main>
    </div>
  );
}

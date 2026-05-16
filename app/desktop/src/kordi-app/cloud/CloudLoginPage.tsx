import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { ArrowUp } from 'lucide-react';

import { applyCloudLoginWindowSize, type CloudLoginMode } from '@/features/cloud/loginWindow';
import {
  readAvatarPreference,
  writeAvatarPreference,
  type AvatarPreference,
} from '@/features/cloud/avatarPreference';
import { CloudAuthError, type CloudOAuthProvider } from '@/features/cloud/authClient';
import {
  readLoginModePreference,
  writeLoginModePreference,
} from '@/features/cloud/loginModePreference';
import { fileToAvatarDataUrl } from '@/kordi-app/components/avatarOverrides';

import { GitHubMark, GoogleMark } from './CloudLoginMarks';

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
// rendered inside a `.bridge-app` root (CloudGateShell), so
// `.bridge-app.theme-light` and `.bridge-app.theme-dark` cascades apply
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

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PASSWORD_MIN_LENGTH = 8;

function messageForError(error: CloudAuthError): string {
  switch (error.code) {
    case 'invalid_email':
      return 'That email address looks malformed.';
    case 'weak_password':
      return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    case 'email_in_use':
      return 'An account with that email already exists. Try signing in instead.';
    case 'invalid_credentials':
      return 'Email or password is incorrect.';
    case 'rate_limited':
      return 'Too many attempts. Wait a moment, then try again.';
    case 'invalid_session':
    case 'account_missing':
      return 'Your session expired. Please sign in again.';
    case 'network_error':
      return 'Could not reach the cloud server. Check your connection and try again.';
    case 'server_error':
      return 'The server hit an unexpected error. Please try again.';
    case 'missing_avatar':
      return 'Upload an avatar to create your account.';
    case 'invalid_avatar':
      return 'Could not process that avatar. Try another image.';
    default:
      return error.message || 'Something went wrong.';
  }
}

function initialAvatarPreference(): AvatarPreference | null {
  return readAvatarPreference();
}

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

const SIGNUP_AVATAR_PALETTES = [
  { background: 'linear-gradient(135deg, #f97316 0%, #ec4899 100%)', foreground: '#fff7ed' },
  { background: 'linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%)', foreground: '#f8fafc' },
  { background: 'linear-gradient(135deg, #14b8a6 0%, #84cc16 100%)', foreground: '#ecfeff' },
  { background: 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)', foreground: '#fff7ed' },
  { background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)', foreground: '#f5f3ff' },
];

function hashText(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function cloudSignupAvatarInitials(displayName: string | null | undefined) {
  const compact = Array.from(displayName?.trim().replace(/\s+/g, '') || '').filter((char) => /[\p{L}\p{N}]/u.test(char));
  return compact.slice(0, 2).join('').toLocaleUpperCase() || 'KO';
}

function cloudSignupAvatarPalette(displayName: string | null | undefined) {
  const key = displayName?.trim() || 'kordi-cloud-signup';
  return SIGNUP_AVATAR_PALETTES[hashText(key) % SIGNUP_AVATAR_PALETTES.length] ?? SIGNUP_AVATAR_PALETTES[0];
}

function UploadAvatarPlaceholder({ displayName }: { displayName: string }) {
  const palette = cloudSignupAvatarPalette(displayName);
  return (
    <span
      data-cloud-signup-avatar-placeholder="true"
      className="grid h-full w-full place-items-center text-[15px] font-bold tracking-[0.03em]"
      style={{ background: palette.background, color: palette.foreground }}
      aria-hidden="true"
    >
      {cloudSignupAvatarInitials(displayName)}
    </span>
  );
}

function AvatarPicker({
  preference,
  displayName,
  onAvatarFile,
  uploadError,
  disabled,
}: {
  preference: AvatarPreference | null;
  displayName: string;
  onAvatarFile: (file: File | undefined) => void;
  uploadError?: string;
  disabled?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageUrl = preference?.dataUrl;

  return (
    <div className="grid h-12 w-20 place-items-center">
      <div className="relative h-12 w-12">
        <button
          type="button"
          onClick={() => { if (!disabled) fileInputRef.current?.click(); }}
          title="Upload avatar"
          aria-label="Upload avatar"
          disabled={disabled}
          className={[
            'app-cloud-login-avatar group relative block h-12 w-12 overflow-hidden rounded-full border transition duration-150 hover:scale-[1.01] focus-visible:outline-none',
            BORDER_INNER,
            PAPER_SUNK,
            SMALL_FOCUS_RING,
          ].join(' ')}
        >
          {imageUrl ? <img src={imageUrl} alt="" className="h-full w-full object-cover" draggable={false} /> : <UploadAvatarPlaceholder displayName={displayName} />}
          {!uploadError ? (
            <span
              data-cloud-signup-avatar-upload-icon="true"
              data-cloud-signup-avatar-upload-dock="true"
              className="absolute bottom-0 left-1/2 grid h-[15px] w-[32px] -translate-x-1/2 place-items-center rounded-t-[999px] border-t border-white/18 bg-white/[0.16] text-white/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] backdrop-blur-[2px] transition duration-150 group-hover:h-4 group-hover:bg-white/[0.22] group-hover:text-white"
              aria-hidden="true"
            >
              <ArrowUp className="h-[9px] w-[9px] -translate-y-px" strokeWidth={2.35} />
            </span>
          ) : null}
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        aria-label="Upload avatar"
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          onAvatarFile(file);
        }}
      />
      {uploadError ? (
        <span className={`${TYPE_HINT} max-w-28 text-center normal-case tracking-normal text-[var(--app-cloud-login-danger-text)]`}>
          {uploadError}
        </span>
      ) : null}
    </div>
  );
}

export type CloudLoginPageProps = {
  initialMode?: CloudLoginMode;
  onSignIn?: (email: string, password: string) => Promise<void>;
  onSignUp?: (input: {
    email: string;
    password: string;
    displayName?: string;
    avatarUrl?: string;
  }) => Promise<void>;
  onSocialSignIn?: (provider: CloudOAuthProvider) => Promise<void>;
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
}: CloudLoginPageProps = {}) {
  const [mode, setMode] = useState<CloudLoginMode>(() => readLoginModePreference() ?? initialMode);
  const [avatarPref, setAvatarPref] = useState<AvatarPreference | null>(() => initialAvatarPreference());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [socialProvider, setSocialProvider] = useState<CloudOAuthProvider | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | undefined>(undefined);
  const uploadErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSignup = mode === 'signup';

  useEffect(() => {
    void applyCloudLoginWindowSize(mode);
    writeLoginModePreference(mode);
  }, [mode]);

  useEffect(() => {
    return () => {
      if (uploadErrorTimerRef.current) clearTimeout(uploadErrorTimerRef.current);
    };
  }, []);

  function flashUploadError(message: string) {
    if (uploadErrorTimerRef.current) clearTimeout(uploadErrorTimerRef.current);
    setUploadError(message);
    uploadErrorTimerRef.current = setTimeout(() => setUploadError(undefined), 3500);
  }

  function persistAvatar(next: AvatarPreference): boolean {
    const ok = writeAvatarPreference(next);
    if (ok) setAvatarPref(next);
    return ok;
  }

  function handleAvatarFile(file: File | undefined) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      flashUploadError('Choose a PNG, JPEG, or WebP image.');
      return;
    }
    void fileToAvatarDataUrl(file)
      .then((dataUrl) => {
        const ok = persistAvatar({ kind: 'upload', dataUrl });
        if (!ok) flashUploadError('Could not process that avatar. Try another image.');
      })
      .catch((caught: unknown) => {
        flashUploadError(caught instanceof Error ? caught.message : 'Could not use that image.');
      });
  }

  const emailInvalid = email.length > 0 && !EMAIL_PATTERN.test(email);
  const passwordTooShort = isSignup && password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const passwordMismatch = isSignup && confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (!EMAIL_PATTERN.test(email)) return false;
    if (password.length < PASSWORD_MIN_LENGTH) return false;
    if (isSignup && password !== confirmPassword) return false;
    if (isSignup && !avatarPref) return false;
    return true;
  }, [avatarPref, confirmPassword, email, isSignup, password, submitting]);

  const submitLabel = isSignup
    ? submitting
      ? 'Creating account…'
      : 'Create account'
    : submitting
      ? 'Signing in…'
      : 'Continue';

  async function handleSocialSignIn(provider: CloudOAuthProvider) {
    if (!onSocialSignIn || socialProvider) return;
    setSocialProvider(provider);
    setSubmitError(null);
    try {
      await onSocialSignIn(provider);
    } catch (caught) {
      if (caught instanceof CloudAuthError) {
        setSubmitError(messageForError(caught));
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
        if (!avatarPref) {
          setSubmitError('Upload an avatar to create your account.');
          return;
        }
        await onSignUp({
          email,
          password,
          displayName: trimmedName.length > 0 ? trimmedName : undefined,
          avatarUrl: avatarPref.dataUrl,
        });
      } else {
        await onSignIn(email, password);
      }
    } catch (caught) {
      if (caught instanceof CloudAuthError) {
        setSubmitError(messageForError(caught));
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

      <div className="absolute left-0 right-0 top-0 h-12" style={{ WebkitAppRegion: 'drag' as const }} />
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
          {SOCIAL_LOGIN_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              disabled={!onSocialSignIn || Boolean(socialProvider)}
              title={`Continue with ${provider.label}`}
              aria-label={`Continue with ${provider.label}`}
              data-provider={provider.id}
              onClick={() => void handleSocialSignIn(provider.id)}
              className={[
                'app-cloud-login-social-pill flex h-10 w-10 items-center justify-center rounded-full transition duration-150',
                'hover:scale-105 focus-visible:outline-none',
                'focus-visible:ring-2 focus-visible:ring-[var(--app-cloud-login-focus-ring-visible)]',
                'disabled:cursor-wait disabled:opacity-55',
                INK,
              ].join(' ')}
            >
              <provider.Mark />
              {socialProvider === provider.id ? <span className="sr-only">Starting…</span> : null}
            </button>
          ))}
        </div>

        <div className={`mt-5 flex items-center gap-3 ${TYPE_DIVIDER} ${INK_SUBTLE}`}>
          <div className="h-px flex-1 bg-[var(--app-cloud-login-divider)]" />
          or
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
              <AvatarPicker
                preference={avatarPref}
                displayName={displayName}
                onAvatarFile={handleAvatarFile}
                uploadError={uploadError}
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

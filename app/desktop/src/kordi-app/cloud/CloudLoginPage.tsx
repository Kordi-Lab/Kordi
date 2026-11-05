import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { applyCloudLoginWindowSize, type CloudLoginMode } from '@/features/cloud/loginWindow';
import { CLOUD_LOGIN_WINDOW_DRAG_STYLE } from '@/app/windowDrag';
import { CloudAuthError, type CloudOAuthProvider, type CloudSignupCodeChallenge, type CloudSignupInput } from '@/features/cloud/authClient';
import { isCloudOAuthCancelled } from '@/features/cloud/cloudOAuthCancellation';
import { managedSignedOutNotice, type ManagedSignInMethod } from '@/features/cloud/managedPolicy/managedSignInPolicy';
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
import { cloudLoginErrorMessage, loginHeading, loginSubtitle, PASSWORD_RULE_HINT, passwordMeetsSignupRule } from './cloudLoginMessages';
import { CloudField, INK, INK_MUTED, TYPE_HINT } from './CloudLoginField';
import { CloudSignupAvatarPicker } from './CloudSignupAvatarPicker';
import { CloudSignupVerificationFields } from './CloudSignupVerificationFields';
import { useCloudSignupVerification } from './useCloudSignupVerification';

// Type scale — one place, applied everywhere. The whole page reads from these.
const TYPE_DISPLAY = 'text-[34px] leading-[1.1] font-bold tracking-[-0.025em]';
const TYPE_ACTION = 'text-[13px] font-semibold tracking-[-0.005em]';
const TYPE_TAB = 'text-[13px] font-semibold tracking-[-0.005em]';
const TYPE_DIVIDER = 'text-[10px] font-semibold uppercase tracking-[0.18em]';
const TYPE_TITLEBAR = 'text-[12px] font-semibold tracking-[0.02em]';

// Color is driven by the shared theme tokens (theme-tokens.css). The page is
// rendered inside a `.kordi-app` root (CloudGateShell), so
// `.kordi-app.theme-light` and `.kordi-app.theme-dark` cascades apply
// automatically. Decorative layers (page bg gradient, paper grain) are themed
// via `theme-overrides.css` keyed off the same class names used below.
const INK_SUBTLE = 'text-[var(--utility-meta-text)]';
const PAPER_RAISED = 'bg-[var(--app-cloud-login-raised-bg)]';
const PAPER_SUNK = 'bg-[var(--app-cloud-login-sunk-bg)]';
const BORDER_INNER = 'border-[var(--app-cloud-login-inner-border)]';
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

export type CloudLoginPageProps = {
  onModeChange?: (mode: CloudLoginMode) => void;
  initialMode?: CloudLoginMode;
  onSignIn?: (email: string, password: string) => Promise<void>;
  onRequestSignupCode?: (email: string) => Promise<CloudSignupCodeChallenge>;
  onSignUp?: (input: CloudSignupInput) => Promise<void>;
  onSocialSignIn?: (provider: CloudOAuthProvider) => Promise<void>;
  showDebugAuthDiagnostics?: boolean;
  /** Methods a managed device allows; null or omitted allows every method. */
  allowedSignInMethods?: readonly ManagedSignInMethod[] | null;
};

const noopSignIn = async () => {
  /* preview-only fallback for tests / browser */
};
const noopSignUp = noopSignIn;

export function CloudLoginPage({
  initialMode = 'login',
  onSignIn = noopSignIn,
  onSignUp = noopSignUp,
  onRequestSignupCode,
  onSocialSignIn,
  showDebugAuthDiagnostics = false,
  onModeChange,
  allowedSignInMethods = null,
}: CloudLoginPageProps = {}) {
  const [mode, setMode] = useState<CloudLoginMode>(() => readLoginModePreference() ?? initialMode);
  const [avatarSeed, setAvatarSeed] = useState(() => newCanonicalAvatarSeed());
  const [uploadedAvatar, setUploadedAvatar] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [socialProvider, setSocialProvider] = useState<CloudOAuthProvider | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(managedSignedOutNotice);
  const { challenge, verificationCode, setVerificationCode, resendSeconds, sendCode, resetVerification } = useCloudSignupVerification(email, onRequestSignupCode);
  const isSignup = mode === 'signup';
  const isVerifying = isSignup && challenge !== null;
  const isBusy = submitting || socialProvider !== null;
  const allows = (method: ManagedSignInMethod) => allowedSignInMethods === null || allowedSignInMethods.includes(method);
  const visibleProviders = SOCIAL_LOGIN_PROVIDERS.filter((provider) => allows(provider.id));
  const emailAllowed = allows('email');
  const enabledSocialProviders = onSocialSignIn ? ALL_SOCIAL_PROVIDER_IDS.filter(allows) : [];
  const generatedSignupAvatarUrl = generatedAvatarPreviewUrl(
    HUMAN_CANONICAL_AVATAR_STYLE,
    avatarSeed,
  ) ?? '';

  useEffect(() => {
    if (onModeChange) onModeChange(mode);
    else void applyCloudLoginWindowSize(mode).catch(() => undefined);
    writeLoginModePreference(mode);
  }, [mode, onModeChange]);

  function regenerateAvatar() {
    setUploadedAvatar(null);
    setAvatarSeed(newCanonicalAvatarSeed());
  }

  const emailInvalid = email.length > 0 && !EMAIL_PATTERN.test(email);
  const passwordTooWeak = isSignup && password.length > 0 && !passwordMeetsSignupRule(password);
  const passwordMismatch = isSignup && confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit = useMemo(() => {
    if (isBusy) return false;
    if (!EMAIL_PATTERN.test(email)) return false;
    if (password.length === 0 || (isSignup && !passwordMeetsSignupRule(password))) return false;
    if (isSignup && password !== confirmPassword) return false;
    if (isVerifying && !/^\d{6}$/.test(verificationCode)) return false;
    return true;
  }, [confirmPassword, email, isSignup, password, isBusy, isVerifying, verificationCode]);

  const submitLabel = isSignup
    ? submitting
      ? isVerifying ? 'Creating account…' : 'Sending code…'
      : isVerifying ? 'Verify and create account' : 'Create account'
    : submitting
      ? 'Signing in…'
      : 'Continue';

  async function handleSocialSignIn(provider: CloudOAuthProvider) {
    if (!onSocialSignIn || isBusy || !enabledSocialProviders.includes(provider)) return;
    setSocialProvider(provider);
    setSubmitError(null);
    try {
      await onSocialSignIn(provider);
    } catch (caught) {
      if (isCloudOAuthCancelled(caught)) {
        return;
      } else if (caught instanceof CloudAuthError) {
        setSubmitError(cloudLoginErrorMessage(caught, showDebugAuthDiagnostics));
      } else if (caught instanceof Error) {
        setSubmitError(caught.message);
      } else {
        setSubmitError('Could not start social sign-in.');
      }
    } finally {
      setSocialProvider(null);
    }
  }

  async function resendCode() {
    if (isBusy || resendSeconds > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try { await sendCode(); }
    catch (caught) { setSubmitError(caught instanceof Error ? caught.message : 'Could not send code.'); }
    finally { setSubmitting(false); }
  }

  function changeMode(next: CloudLoginMode) {
    if (isBusy) return;
    setMode(next);
    resetVerification();
    setSubmitError(null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (isSignup) {
        if (!challenge) { await sendCode(); return; }
        const trimmedName = displayName.trim();
        await onSignUp({
          email,
          password,
          verificationId: challenge.verificationId,
          verificationCode,
          displayName: trimmedName.length > 0 ? trimmedName : undefined,
          avatarSeed,
          ...(uploadedAvatar ? { avatarMutation: { action: 'upload' as const, uploadedAsset: uploadedAvatar } } : {}),
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
      <div
        className={`pointer-events-none absolute left-0 right-0 text-center ${TYPE_TITLEBAR} ${INK_SUBTLE}`}
        style={{ top: 'calc(var(--app-gate-crop-y, 0px) + 12px)' }}
      >
        Kordi
      </div>

      <main className="app-cloud-login-panel relative w-full max-w-[440px] px-6">
        <div
          data-cloud-login-mode-copy={modeKey}
          className="app-cloud-login-mode-copy grid justify-items-center text-center"
        >
          <h1 className={`${TYPE_DISPLAY} ${INK}`}>
            {loginHeading(isSignup)}
          </h1>
          <p className={`mt-2 ${TYPE_HINT} normal-case tracking-normal ${INK_MUTED}`}>
            {loginSubtitle(isSignup)}
          </p>
        </div>

        {visibleProviders.length > 0 ? <div className="mt-7 flex items-center justify-center gap-6">
          {visibleProviders.map((provider) => {
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
                disabled={!isAvailable || isBusy}
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
        </div> : null}
        {!emailAllowed && submitError ? <div role="alert" className={`app-cloud-login-error mt-5 rounded-[14px] border px-4 py-2.5 ${TYPE_HINT}`}>{submitError}</div> : null}

        {emailAllowed ? <><div className={`mt-5 flex items-center gap-3 ${TYPE_DIVIDER} ${INK_SUBTLE}`}>
          <div className="h-px flex-1 bg-[var(--app-cloud-login-divider)]" />
          {onSocialSignIn && visibleProviders.length > 0 ? 'or' : 'Email and password'}
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
            onClick={() => changeMode('login')}
            disabled={isBusy}
            aria-pressed={!isSignup}
            className={`${tabBaseClass} ${!isSignup ? tabActiveText : tabInactiveText}`}
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => changeMode('signup')}
            disabled={isBusy}
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
            data-cloud-login-signup-section={isSignup && !isVerifying ? 'open' : 'closed'}
            aria-hidden={!isSignup || isVerifying}
          >
            <div className="app-cloud-login-signup-field grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
              <CloudSignupAvatarPicker
                imageUrl={uploadedAvatar ?? generatedSignupAvatarUrl}
                onUpload={setUploadedAvatar}
                onRegenerate={regenerateAvatar}
                disabled={!isSignup || isVerifying || isBusy}
              />
              <CloudField
                ariaLabel="Display name"
                type="text"
                autoComplete="name"
                placeholder="Display name"
                value={displayName}
                onChange={setDisplayName}
                disabled={!isSignup || isVerifying || isBusy}
              />
            </div>
          </div>
          <CloudField
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(next) => { setEmail(next); resetVerification(); }}
            disabled={isBusy || isVerifying}
            validation={emailInvalid ? 'invalid' : undefined}
            hint={emailInvalid ? 'Use a full email like name@example.com.' : undefined}
          />
          {!isVerifying ? <CloudField
            label="Password"
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            placeholder="••••••••"
            value={password}
            onChange={setPassword}
            disabled={isBusy}
            validation={passwordTooWeak ? 'hint' : undefined}
            hint={passwordTooWeak ? PASSWORD_RULE_HINT : undefined}
          /> : null}
          <div
            className="app-cloud-login-signup-section"
            data-cloud-login-signup-section={isSignup && !isVerifying ? 'open' : 'closed'}
            aria-hidden={!isSignup || isVerifying}
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
                disabled={!isSignup || isVerifying || isBusy}
              />
            </div>
          </div>
          {isVerifying ? (
            <CloudSignupVerificationFields email={email} busy={isBusy} resendSeconds={resendSeconds}
              onResend={() => void resendCode()} onChangeEmail={() => { resetVerification(); setSubmitError(null); }}>
              <CloudField label="Email verification code" type="text" autoComplete="one-time-code"
                inputMode="numeric" maxLength={6} placeholder="123456" value={verificationCode}
                onChange={(next) => setVerificationCode(next.replace(/\D/g, '').slice(0, 6))} disabled={isBusy} />
            </CloudSignupVerificationFields>
          ) : isSignup ? <p className={`${TYPE_HINT} ${INK_MUTED}`}>We’ll email you a code to verify your address before creating your account.</p> : null}
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
        </form></> : null}
      </main>
    </div>
  );
}

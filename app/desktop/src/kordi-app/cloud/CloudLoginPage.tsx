import { useEffect, useRef, useState } from 'react';

import { applyCloudLoginWindowSize, type CloudLoginMode } from '@/features/cloud/loginWindow';
import {
  CLOUD_SIGNUP_AVATAR_KEY,
  randomAvatarSeed,
  readAvatarPreference,
  writeAvatarPreference,
  type AvatarPreference,
} from '@/features/cloud/avatarPreference';
import {
  readLoginModePreference,
  writeLoginModePreference,
} from '@/features/cloud/loginModePreference';
import { fileToAvatarDataUrl } from '@/kordi-app/components/avatarOverrides';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';

// Type scale — one place, applied everywhere. The whole page reads from these.
const TYPE_DISPLAY = 'text-[34px] leading-[1.1] font-bold tracking-[-0.025em]';
const TYPE_LABEL = 'text-[11px] font-semibold uppercase tracking-[0.10em]';
const TYPE_INPUT = 'text-[15px] font-medium tracking-[-0.005em]';
const TYPE_ACTION = 'text-[13px] font-semibold tracking-[-0.005em]';
const TYPE_TAB = 'text-[13px] font-semibold tracking-[-0.005em]';
const TYPE_HINT = 'text-[12px] font-medium tracking-[-0.005em]';
const TYPE_DIVIDER = 'text-[10px] font-semibold uppercase tracking-[0.18em]';
const TYPE_TITLEBAR = 'text-[12px] font-semibold tracking-[0.02em]';

// Color tokens — paper, ink, borders, focus.
const INK = 'text-[oklch(0.22_0.02_125)]';
const INK_MUTED = 'text-[oklch(0.42_0.02_125/0.78)]';
const INK_SUBTLE = 'text-[oklch(0.52_0.025_82/0.62)]';
const PAPER_RAISED = 'bg-[oklch(0.995_0.01_82)]';
const PAPER_SUNK = 'bg-[oklch(0.93_0.028_82/0.66)]';
const PAPER_INPUT = 'bg-[oklch(0.99_0.014_82/0.78)]';
const BORDER_SOFT = 'border-[oklch(0.74_0.045_82/0.42)]';
const BORDER_INNER = 'border-[oklch(0.78_0.035_82/0.34)]';
const FOCUS_RING = 'focus:border-[oklch(0.72_0.16_211/0.68)] focus:shadow-[0_0_0_3px_oklch(0.72_0.16_211/0.14)]';

const SOCIAL_LOGIN_PROVIDERS = [
  { id: 'google', label: 'Google', glyph: 'G' },
  { id: 'github', label: 'GitHub', glyph: 'GH' },
  { id: 'x', label: 'X', glyph: '𝕏' },
] as const;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PASSWORD_MIN_LENGTH = 8;
const COMING_SOON_HINT = 'Coming soon';

function initialAvatarPreference(initialMode: CloudLoginMode): AvatarPreference {
  const existing = readAvatarPreference();
  if (existing) return existing;

  const fresh: AvatarPreference = { kind: 'seed', seed: randomAvatarSeed() };
  if (initialMode === 'signup') writeAvatarPreference(fresh);
  return fresh;
}

function KordiPaintMark() {
  const circleClass = 'absolute h-[62.9326%] w-[59.5238%] rounded-full opacity-[0.93] mix-blend-multiply shadow-[inset_0_3px_8px_rgba(255,255,255,0.16)]';

  return (
    <span
      aria-hidden="true"
      className="kordi-paint-mark relative inline-block h-[42px] w-[71px] shrink-0 drop-shadow-[0_10px_18px_rgba(65,47,24,0.10)]"
    >
      <span
        className={`${circleClass} left-[20.2381%] top-0 bg-[radial-gradient(circle_at_34%_24%,rgba(255,255,255,0.18),transparent_30%),oklch(0.66_0.26_355)]`}
      />
      <span
        className={`${circleClass} left-0 top-[37.0673%] bg-[radial-gradient(circle_at_30%_24%,rgba(255,255,255,0.16),transparent_31%),oklch(0.72_0.16_211)]`}
      />
      <span
        className={`${circleClass} left-[40.4762%] top-[37.0673%] bg-[radial-gradient(circle_at_32%_24%,rgba(255,255,255,0.18),transparent_30%),oklch(0.82_0.16_83)]`}
      />
    </span>
  );
}

type CloudFieldValidation = 'invalid' | 'hint' | undefined;

function CloudField({
  label,
  type,
  autoComplete,
  placeholder,
  value,
  onChange,
  validation,
  hint,
}: {
  label: string;
  type: string;
  autoComplete: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
  validation?: CloudFieldValidation;
  hint?: string;
}) {
  const baseInput = `h-12 rounded-full border ${PAPER_INPUT} px-5 ${TYPE_INPUT} ${INK} outline-none transition placeholder:text-[oklch(0.57_0.024_82/0.62)] focus:bg-[oklch(0.995_0.01_82)]`;
  const tone =
    validation === 'invalid'
      ? 'border-[oklch(0.62_0.20_25/0.55)] focus:border-[oklch(0.62_0.20_25/0.78)] focus:shadow-[0_0_0_3px_oklch(0.62_0.20_25/0.14)]'
      : validation === 'hint'
      ? `${BORDER_SOFT} focus:border-[oklch(0.78_0.14_75/0.78)] focus:shadow-[0_0_0_3px_oklch(0.78_0.14_75/0.16)]`
      : `${BORDER_SOFT} ${FOCUS_RING}`;
  return (
    <label className={`grid gap-1.5 ${TYPE_LABEL} ${INK_MUTED}`}>
      {label}
      <input
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-invalid={validation === 'invalid' || undefined}
        className={`${baseInput} ${tone}`}
      />
      {hint ? (
        <span
          className={`${TYPE_HINT} normal-case tracking-normal ${
            validation === 'invalid' ? 'text-[oklch(0.55_0.18_25)]' : 'text-[oklch(0.49_0.06_75)]'
          }`}
        >
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function AvatarPicker({
  preference,
  onRandomAvatar,
  onAvatarFile,
  uploadError,
}: {
  preference: AvatarPreference;
  onRandomAvatar: () => void;
  onAvatarFile: (file: File | undefined) => void;
  uploadError?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const seed = preference.kind === 'seed' ? preference.seed : 'cloud-signup:upload';
  const imageUrl = preference.kind === 'upload' ? preference.dataUrl : undefined;

  const buttonClass = `h-10 rounded-full border ${BORDER_INNER} ${PAPER_RAISED} ${TYPE_ACTION} ${INK} transition hover:bg-[oklch(0.998_0.008_82)] hover:border-[oklch(0.70_0.045_82/0.55)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[oklch(0.72_0.16_211/0.45)]`;

  return (
    <div className={`grid gap-3 rounded-[20px] border ${BORDER_INNER} ${PAPER_SUNK} p-3.5`}>
      <div className="flex items-center gap-3.5">
        <IdentityAvatar
          kind="human"
          seed={seed}
          name="Cloud signup avatar"
          imageUrl={imageUrl}
          avatarKey={CLOUD_SIGNUP_AVATAR_KEY}
          className="h-12 w-12 shrink-0 rounded-full border border-[oklch(0.62_0.05_82/0.28)] shadow-[inset_0_1px_0_oklch(1_0_0/0.45)]"
        />
        <div className="grid flex-1 grid-cols-2 gap-2">
          <button type="button" onClick={() => fileInputRef.current?.click()} className={buttonClass}>
            Upload avatar
          </button>
          <button type="button" onClick={onRandomAvatar} className={buttonClass}>
            Random avatar
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            aria-label="Upload avatar"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              onAvatarFile(file);
            }}
          />
        </div>
      </div>
      {uploadError ? (
        <span className={`${TYPE_HINT} normal-case tracking-normal text-[oklch(0.55_0.18_25)]`}>{uploadError}</span>
      ) : null}
    </div>
  );
}

export function CloudLoginPage({ initialMode = 'login' }: { initialMode?: CloudLoginMode }) {
  const [mode, setMode] = useState<CloudLoginMode>(() => readLoginModePreference() ?? initialMode);
  const [avatarPref, setAvatarPref] = useState<AvatarPreference>(() => initialAvatarPreference(mode));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    void fileToAvatarDataUrl(file)
      .then((dataUrl) => {
        const ok = persistAvatar({ kind: 'upload', dataUrl });
        if (!ok) flashUploadError('That image is too large. Try one under 200 KB.');
      })
      .catch((caught: unknown) => {
        flashUploadError(caught instanceof Error ? caught.message : 'Could not use that image.');
      });
  }

  function randomizeAvatar() {
    persistAvatar({ kind: 'seed', seed: randomAvatarSeed() });
  }

  const emailInvalid = email.length > 0 && !EMAIL_PATTERN.test(email);
  const passwordTooShort = isSignup && password.length > 0 && password.length < PASSWORD_MIN_LENGTH;

  const tabBaseClass = `relative z-10 rounded-full px-3 py-1.5 ${TYPE_TAB} transition`;
  const tabActiveText = INK;
  const tabInactiveText = `${INK_MUTED} hover:${INK}`;

  return (
    <div
      className={`fixed inset-0 z-[100] grid place-items-center overflow-hidden bg-[oklch(0.955_0.026_82)] p-5 ${INK}`}
      style={{ WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_14%_10%,oklch(0.72_0.16_211/0.10),transparent_28%),radial-gradient(circle_at_84%_14%,oklch(0.66_0.26_355/0.08),transparent_26%),radial-gradient(circle_at_74%_82%,oklch(0.82_0.16_83/0.12),transparent_30%),linear-gradient(90deg,oklch(0.39_0.035_82/0.030)_1px,transparent_1px),linear-gradient(0deg,oklch(0.39_0.035_82/0.022)_1px,transparent_1px)] bg-[length:auto,auto,auto,14px_14px,16px_16px]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.18] mix-blend-multiply [background-image:repeating-linear-gradient(7deg,oklch(0.35_0.03_82/0.05)_0_1px,transparent_1px_9px)]" />

      <div className="absolute left-0 right-0 top-0 h-12" style={{ WebkitAppRegion: 'drag' as const }} />
      <div className={`pointer-events-none absolute left-0 right-0 top-3 text-center ${TYPE_TITLEBAR} ${INK_SUBTLE}`}>
        Kordi
      </div>

      <main className="relative w-full max-w-[440px] px-6">
        <div className="grid justify-items-center text-center">
          <KordiPaintMark />
          <h1 className={`mt-7 ${TYPE_DISPLAY} ${INK}`}>
            {isSignup ? 'Create your account' : 'Welcome to Kordi'}
          </h1>
          <p className={`mt-2 ${TYPE_HINT} normal-case tracking-normal ${INK_MUTED}`}>
            {isSignup ? 'Sign up to sync your Kordi workspace.' : 'Sign in to your Kordi workspace.'}
          </p>
        </div>

        <div className="mt-7 grid grid-cols-3 gap-2">
          {SOCIAL_LOGIN_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              disabled
              title={COMING_SOON_HINT}
              aria-label={`${provider.label} sign-in coming soon`}
              className={`flex h-11 items-center justify-center gap-2 rounded-full border ${BORDER_SOFT} ${PAPER_RAISED} ${TYPE_ACTION} ${INK} shadow-[0_4px_12px_oklch(0.40_0.035_82/0.06)] transition disabled:cursor-not-allowed disabled:opacity-80`}
            >
              <span className={`${TYPE_LABEL} normal-case tracking-tight ${INK_MUTED}`}>{provider.glyph}</span>
              {provider.label}
            </button>
          ))}
        </div>

        <div className={`mt-5 flex items-center gap-3 ${TYPE_DIVIDER} ${INK_SUBTLE}`}>
          <div className="h-px flex-1 bg-[oklch(0.70_0.04_82/0.30)]" />
          or
          <div className="h-px flex-1 bg-[oklch(0.70_0.04_82/0.30)]" />
        </div>

        <div className={`relative mt-5 grid grid-cols-2 gap-1 rounded-full border ${BORDER_INNER} ${PAPER_SUNK} p-1`}>
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] rounded-full ${PAPER_RAISED} shadow-[0_4px_12px_oklch(0.42_0.04_82/0.10)] transition-transform duration-200 ease-out`}
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

        <form className="mt-5 grid gap-3.5" onSubmit={(event) => event.preventDefault()}>
          {isSignup ? (
            <>
              <AvatarPicker
                preference={avatarPref}
                onRandomAvatar={randomizeAvatar}
                onAvatarFile={handleAvatarFile}
                uploadError={uploadError}
              />
              <CloudField
                label="Name"
                type="text"
                autoComplete="name"
                placeholder="Ada Lovelace"
                value=""
                onChange={() => {
                  /* preview-only; controlled by future auth slice */
                }}
              />
            </>
          ) : null}
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
          <button
            type="submit"
            disabled
            title={COMING_SOON_HINT}
            aria-label={isSignup ? 'Create account — coming soon' : 'Continue — coming soon'}
            className={`mt-1 h-12 rounded-full border border-[oklch(0.27_0.02_125/0.10)] bg-[oklch(0.22_0.02_125)] ${TYPE_ACTION} text-[oklch(0.985_0.015_82)] shadow-[0_10px_24px_oklch(0.25_0.03_125/0.18)] disabled:cursor-not-allowed disabled:opacity-90`}
          >
            {isSignup ? 'Create account' : 'Continue'}
          </button>
        </form>
      </main>
    </div>
  );
}

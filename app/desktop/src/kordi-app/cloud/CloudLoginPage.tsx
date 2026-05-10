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
  // Only persist if the user is actually entering signup; otherwise keep storage clean.
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
  const baseInput =
    'h-14 rounded-full border bg-[oklch(0.99_0.014_82/0.78)] px-5 text-[16px] font-semibold text-[oklch(0.23_0.02_125)] outline-none transition placeholder:text-[oklch(0.57_0.024_82/0.68)] focus:bg-[oklch(0.995_0.01_82)]';
  const tone =
    validation === 'invalid'
      ? 'border-[oklch(0.62_0.20_25/0.65)] focus:border-[oklch(0.62_0.20_25/0.85)] focus:shadow-[0_0_0_3px_oklch(0.62_0.20_25/0.16)]'
      : validation === 'hint'
      ? 'border-[oklch(0.74_0.045_82/0.48)] focus:border-[oklch(0.78_0.14_75/0.78)] focus:shadow-[0_0_0_3px_oklch(0.78_0.14_75/0.18)]'
      : 'border-[oklch(0.74_0.045_82/0.48)] focus:border-[oklch(0.72_0.16_211/0.68)] focus:shadow-[0_0_0_3px_oklch(0.72_0.16_211/0.14)]';
  return (
    <label className="grid gap-1.5 text-[12px] font-semibold text-[oklch(0.39_0.025_82)]">
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
          className={`text-[11px] font-medium ${
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
  const seed = preference.kind === 'seed' ? preference.seed : 'cloud-signup:upload';
  const imageUrl = preference.kind === 'upload' ? preference.dataUrl : undefined;

  return (
    <div className="grid gap-2 rounded-[18px] border border-[oklch(0.73_0.045_82/0.34)] bg-[oklch(0.94_0.025_82/0.46)] p-3">
      <div className="flex items-center gap-3">
        <IdentityAvatar
          kind="human"
          seed={seed}
          name="Cloud signup avatar"
          imageUrl={imageUrl}
          avatarKey={CLOUD_SIGNUP_AVATAR_KEY}
          className="h-14 w-14 shrink-0 rounded-full border border-[oklch(0.62_0.05_82/0.30)] shadow-[inset_0_1px_0_oklch(1_0_0/0.45)]"
        />
        <div className="grid flex-1 grid-cols-2 gap-2">
          <label className="grid h-9 cursor-pointer place-items-center rounded-[12px] border border-[oklch(0.73_0.045_82/0.46)] bg-[oklch(0.995_0.01_82/0.66)] text-[12px] font-bold text-[oklch(0.29_0.022_125)] transition hover:bg-[oklch(0.995_0.01_82)]">
            Upload avatar
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                onAvatarFile(file);
              }}
            />
          </label>
          <button
            type="button"
            onClick={onRandomAvatar}
            className="h-9 rounded-[12px] border border-[oklch(0.73_0.045_82/0.46)] bg-[oklch(0.995_0.01_82/0.66)] text-[12px] font-bold text-[oklch(0.29_0.022_125)] transition hover:bg-[oklch(0.995_0.01_82)]"
          >
            Random avatar
          </button>
        </div>
      </div>
      {uploadError ? (
        <span className="text-[11px] font-medium text-[oklch(0.55_0.18_25)]">{uploadError}</span>
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
        if (!ok) flashUploadError('That image is too large. Try one under 200KB.');
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

  const tabBaseClass = 'relative z-10 rounded-[11px] px-3 py-2 text-[13px] font-bold transition';
  const tabActiveText = 'text-[oklch(0.22_0.02_125)]';
  const tabInactiveText = 'text-[oklch(0.45_0.025_82/0.72)] hover:text-[oklch(0.22_0.02_125)]';

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center overflow-hidden bg-[oklch(0.955_0.026_82)] p-5 text-[oklch(0.23_0.02_125)]"
      style={{ WebkitAppRegion: 'no-drag' as const }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_14%_10%,oklch(0.72_0.16_211/0.13),transparent_26%),radial-gradient(circle_at_84%_14%,oklch(0.66_0.26_355/0.10),transparent_25%),radial-gradient(circle_at_74%_82%,oklch(0.82_0.16_83/0.15),transparent_30%),linear-gradient(90deg,oklch(0.39_0.035_82/0.035)_1px,transparent_1px),linear-gradient(0deg,oklch(0.39_0.035_82/0.025)_1px,transparent_1px)] bg-[length:auto,auto,auto,13px_13px,15px_15px]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.24] mix-blend-multiply [background-image:repeating-linear-gradient(7deg,oklch(0.35_0.03_82/0.06)_0_1px,transparent_1px_8px)]" />

      <div className="absolute left-0 right-0 top-0 h-16" style={{ WebkitAppRegion: 'drag' as const }} />
      <div className="pointer-events-none absolute left-0 right-0 top-3 text-center text-[20px] font-semibold tracking-[-0.03em] text-[oklch(0.42_0.018_125/0.58)]">
        Kordi
      </div>

      <main className="relative w-full max-w-[560px] px-8 pt-14">
        <div className="grid justify-items-center text-center">
          <KordiPaintMark />
          <h1 className="mt-12 text-[44px] font-extrabold tracking-[-0.055em] text-[oklch(0.20_0.018_125)]">
            {isSignup ? 'Create account' : 'Welcome to Kordi'}
          </h1>
          <p className="mt-4 text-[21px] font-medium tracking-[-0.03em] text-[oklch(0.48_0.018_125/0.70)]">Model setup comes next.</p>
        </div>

        <div className="mt-9 grid grid-cols-3 gap-2">
          {SOCIAL_LOGIN_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              disabled
              title={COMING_SOON_HINT}
              aria-label={`${provider.label} sign-in coming soon`}
              className="flex h-12 items-center justify-center gap-2 rounded-full border border-[oklch(0.78_0.035_82/0.42)] bg-[oklch(0.995_0.01_82/0.70)] text-[14px] font-bold text-[oklch(0.24_0.018_125)] shadow-[0_8px_22px_oklch(0.40_0.035_82/0.08)] disabled:cursor-not-allowed disabled:opacity-90"
            >
              <span className="text-[12px] font-extrabold">{provider.glyph}</span>
              {provider.label}
            </button>
          ))}
        </div>

        <div className="mt-5 flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[oklch(0.52_0.025_82/0.58)]">
          <div className="h-px flex-1 bg-[oklch(0.70_0.04_82/0.34)]" />
          or
          <div className="h-px flex-1 bg-[oklch(0.70_0.04_82/0.34)]" />
        </div>

        <div className="relative mt-5 grid grid-cols-2 gap-1 rounded-[18px] border border-[oklch(0.73_0.045_82/0.42)] bg-[oklch(0.93_0.028_82/0.68)] p-1">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] rounded-[11px] bg-[oklch(0.995_0.01_82)] shadow-[0_7px_18px_oklch(0.42_0.04_82/0.10)] transition-transform duration-200 ease-out"
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

        <form className="mt-6 grid gap-4" onSubmit={(event) => event.preventDefault()}>
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
            className="mt-2 h-14 rounded-full border border-[oklch(0.27_0.02_125/0.12)] bg-[oklch(0.22_0.02_125)] text-[18px] font-semibold tracking-[-0.02em] text-[oklch(0.985_0.015_82)] shadow-[0_16px_32px_oklch(0.25_0.03_125/0.18)] disabled:cursor-not-allowed disabled:opacity-90"
          >
            {isSignup ? 'Create account' : 'Continue'}
          </button>
        </form>
      </main>
    </div>
  );
}

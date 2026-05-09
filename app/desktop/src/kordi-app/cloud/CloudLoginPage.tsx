import { useEffect, useState } from 'react';

import { applyCloudLoginWindowSize } from '@/features/cloud/loginWindow';

const SOCIAL_LOGIN_PROVIDERS = [
  { id: 'google', label: 'Google', glyph: 'G' },
  { id: 'github', label: 'GitHub', glyph: 'GH' },
  { id: 'x', label: 'X', glyph: '𝕏' },
] as const;

const RANDOM_AVATARS = [
  'linear-gradient(135deg, oklch(0.72 0.16 211), oklch(0.82 0.16 83))',
  'linear-gradient(135deg, oklch(0.66 0.26 355), oklch(0.82 0.16 83))',
  'linear-gradient(135deg, oklch(0.74 0.12 142), oklch(0.72 0.16 211))',
  'linear-gradient(135deg, oklch(0.76 0.12 39), oklch(0.66 0.26 355))',
] as const;

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

function CloudField({
  label,
  type,
  autoComplete,
  placeholder,
}: {
  label: string;
  type: string;
  autoComplete: string;
  placeholder: string;
}) {
  return (
    <label className="grid gap-1.5 text-[12px] font-semibold text-[oklch(0.39_0.025_82)]">
      {label}
      <input
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="h-14 rounded-full border border-[oklch(0.74_0.045_82/0.48)] bg-[oklch(0.99_0.014_82/0.78)] px-5 text-[16px] font-semibold text-[oklch(0.23_0.02_125)] outline-none transition placeholder:text-[oklch(0.57_0.024_82/0.68)] focus:border-[oklch(0.72_0.16_211/0.68)] focus:bg-[oklch(0.995_0.01_82)] focus:shadow-[0_0_0_3px_oklch(0.72_0.16_211/0.14)]"
      />
    </label>
  );
}

function AvatarPicker({
  avatarIndex,
  avatarPreview,
  onRandomAvatar,
  onAvatarFile,
}: {
  avatarIndex: number;
  avatarPreview?: string;
  onRandomAvatar: () => void;
  onAvatarFile: (file: File | undefined) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[18px] border border-[oklch(0.73_0.045_82/0.34)] bg-[oklch(0.94_0.025_82/0.46)] p-3">
      <div
        aria-label="Avatar preview"
        className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full border border-[oklch(0.62_0.05_82/0.30)] text-[18px] font-extrabold text-[oklch(0.985_0.015_82)] shadow-[inset_0_1px_0_oklch(1_0_0/0.45)]"
        style={avatarPreview ? { backgroundImage: `url(${avatarPreview})`, backgroundSize: 'cover', backgroundPosition: 'center' } : { background: RANDOM_AVATARS[avatarIndex] }}
      >
        {avatarPreview ? null : 'K'}
      </div>
      <div className="grid flex-1 grid-cols-2 gap-2">
        <label className="grid h-9 cursor-pointer place-items-center rounded-[12px] border border-[oklch(0.73_0.045_82/0.46)] bg-[oklch(0.995_0.01_82/0.66)] text-[12px] font-bold text-[oklch(0.29_0.022_125)] transition hover:bg-[oklch(0.995_0.01_82)]">
          Upload avatar
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(event) => onAvatarFile(event.currentTarget.files?.[0])}
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
  );
}

export function CloudLoginPage({ initialMode = 'login' }: { initialMode?: 'login' | 'signup' }) {
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode);
  const [avatarIndex, setAvatarIndex] = useState(0);
  const [avatarPreview, setAvatarPreview] = useState<string>();
  const isSignup = mode === 'signup';

  useEffect(() => {
    void applyCloudLoginWindowSize(mode);
  }, [mode]);

  function handleAvatarFile(file: File | undefined) {
    if (!file) return;
    setAvatarPreview(URL.createObjectURL(file));
  }

  function randomizeAvatar() {
    setAvatarPreview(undefined);
    setAvatarIndex((current) => (current + 1) % RANDOM_AVATARS.length);
  }

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

        <div className="mt-5 grid grid-cols-2 gap-1 rounded-[18px] border border-[oklch(0.73_0.045_82/0.42)] bg-[oklch(0.93_0.028_82/0.68)] p-1">
          <button
            type="button"
            onClick={() => setMode('login')}
            className={`rounded-[11px] px-3 py-2 text-[13px] font-bold transition ${!isSignup ? 'bg-[oklch(0.995_0.01_82)] text-[oklch(0.22_0.02_125)] shadow-[0_7px_18px_oklch(0.42_0.04_82/0.10)]' : 'text-[oklch(0.45_0.025_82/0.72)] hover:text-[oklch(0.22_0.02_125)]'}`}
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => setMode('signup')}
            className={`rounded-[11px] px-3 py-2 text-[13px] font-bold transition ${isSignup ? 'bg-[oklch(0.995_0.01_82)] text-[oklch(0.22_0.02_125)] shadow-[0_7px_18px_oklch(0.42_0.04_82/0.10)]' : 'text-[oklch(0.45_0.025_82/0.72)] hover:text-[oklch(0.22_0.02_125)]'}`}
          >
            Sign up
          </button>
        </div>

        <form className="mt-6 grid gap-4" onSubmit={(event) => event.preventDefault()}>
          {isSignup ? (
            <>
              <AvatarPicker
                avatarIndex={avatarIndex}
                avatarPreview={avatarPreview}
                onRandomAvatar={randomizeAvatar}
                onAvatarFile={handleAvatarFile}
              />
              <CloudField label="Name" type="text" autoComplete="name" placeholder="Ada Lovelace" />
            </>
          ) : null}
          <CloudField label="Email" type="email" autoComplete="email" placeholder="you@company.com" />
          <CloudField
            label="Password"
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            placeholder="••••••••"
          />
          <button
            type="submit"
            disabled
            className="mt-2 h-14 rounded-full border border-[oklch(0.27_0.02_125/0.12)] bg-[oklch(0.22_0.02_125)] text-[18px] font-semibold tracking-[-0.02em] text-[oklch(0.985_0.015_82)] shadow-[0_16px_32px_oklch(0.25_0.03_125/0.18)] disabled:cursor-not-allowed disabled:opacity-90"
          >
            {isSignup ? 'Create account' : 'Continue'}
          </button>
        </form>
      </main>
    </div>
  );
}

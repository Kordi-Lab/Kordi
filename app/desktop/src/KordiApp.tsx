import { useEffect, useState } from 'react';

import { AppShellFrame } from '@/app/AppShellFrame';
import { useKordiAppModel } from '@/app/useKordiAppModel';
import { currentKordiEdition, shouldShowCloudLoginGate, type CloudSessionStatus, type KordiEdition } from '@/features/cloud/edition';
import { applyKordiMainWindowSize } from '@/features/cloud/loginWindow';
import { useCloudSession, type UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { CloudLoginPage } from '@/kordi-app/cloud/CloudLoginPage';
import { setLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import type { ResolvedThemeMode } from '@/kordi-app/types';

const AVATAR_URL_PREFIX = 'kordi-pixel-avatar://';

function readSystemTheme(): ResolvedThemeMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// The shell's useKordiUiEffects also writes `theme-*` to <body>, but it only
// runs after KordiAppShell mounts. Before that — on the cloud login gate and
// the restoring-session splash — nothing else applies a theme class, so the
// dark/light tokens never reach those screens. This hook syncs the body class
// to the current system preference while the gate/splash is up; once the
// shell mounts, its effect takes over with the user's saved preference.
function useGateThemeClass() {
  const [theme, setTheme] = useState<ResolvedThemeMode>(() => readSystemTheme());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handle = () => setTheme(mediaQuery.matches ? 'light' : 'dark');
    handle();
    mediaQuery.addEventListener('change', handle);
    return () => mediaQuery.removeEventListener('change', handle);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  return theme;
}

export type KordiAppRootProps = {
  edition?: KordiEdition;
  /**
   * Tests can pass an explicit cloudSessionStatus to render the gate or the
   * shell deterministically. When undefined, the runtime hook drives the
   * gate based on the OS keychain + cloud server.
   */
  cloudSessionStatus?: CloudSessionStatus;
  /** Optional injected hook result for testing without a real Tauri/fetch env. */
  cloudSession?: Pick<UseCloudSessionResult, 'status' | 'account' | 'signIn' | 'signUp' | 'signInWithProvider'>;
};

export function KordiAppRoot({
  edition = currentKordiEdition(),
  cloudSessionStatus,
  cloudSession,
}: KordiAppRootProps = {}) {
  // When edition is local, we don't need any cloud session machinery and
  // shouldShowCloudLoginGate short-circuits anyway. We default to 'signed-out'
  // so existing call sites that relied on the old default keep working.
  if (edition !== 'cloud') {
    if (shouldShowCloudLoginGate({ edition, cloudSessionStatus: cloudSessionStatus ?? 'signed-out' })) {
      return (
        <CloudGateShell>
          <CloudLoginPage />
        </CloudGateShell>
      );
    }
    return <KordiAppShell />;
  }

  return (
    <CloudEditionRoot
      cloudSessionStatusOverride={cloudSessionStatus}
      cloudSessionOverride={cloudSession}
    />
  );
}

// Hosts whatever gate-time screen is showing (login form or restoring-session
// splash) inside the same `bridge-app` root the main shell uses, so the
// theme-tokens.css palette resolves. The wrapping hook installs the system
// theme class on <body> until the shell takes over.
function CloudGateShell({ children }: { children: React.ReactNode }) {
  useGateThemeClass();
  return (
    <div className="bridge-app app-cloud-login-shell">
      {children}
    </div>
  );
}

function CloudEditionRoot({
  cloudSessionStatusOverride,
  cloudSessionOverride,
}: {
  cloudSessionStatusOverride?: CloudSessionStatus;
  cloudSessionOverride?: Pick<UseCloudSessionResult, 'status' | 'account' | 'signIn' | 'signUp' | 'signInWithProvider'>;
}) {
  // Tests can hand us a stubbed session result; in production we use the hook.
  const liveSession = useCloudSession({
    enabled: cloudSessionOverride === undefined,
  });
  const session = cloudSessionOverride ?? liveSession;
  const status: CloudSessionStatus = cloudSessionStatusOverride ?? session.status;
  const account = session.account ?? null;

  // Mirror the cloud account's avatar choice into the local profile slot so
  // the desktop shell renders the user's chosen pixel character (bottom-left
  // of the chat workspace, transcript "you" rows, etc.) instead of a fresh
  // generic seed. Display name sync lives in a follow-up.
  useEffect(() => {
    if (status !== 'authenticated' || !account?.avatarUrl) return;
    if (!account.avatarUrl.startsWith(AVATAR_URL_PREFIX)) return;
    const seed = account.avatarUrl.slice(AVATAR_URL_PREFIX.length).trim();
    if (!seed) return;
    setLocalProfileAvatarSeed(seed);
  }, [status, account?.avatarUrl]);

  if (shouldShowCloudLoginGate({ edition: 'cloud', cloudSessionStatus: status })) {
    return (
      <CloudGateShell>
        <CloudLoginPage
          onSignIn={session.signIn}
          onSignUp={session.signUp}
          onSocialSignIn={session.signInWithProvider}
        />
      </CloudGateShell>
    );
  }
  if (status === 'loading') {
    return (
      <CloudGateShell>
        <CloudStartingScreen />
      </CloudGateShell>
    );
  }
  return <KordiAppShell />;
}

export function CloudStartingScreen({
  status = 'syncing',
}: {
  status?: 'syncing' | 'error';
  onRetry?: () => void;
}) {
  return (
    <div
      className={`app-cloud-starting-screen ${status === 'error' ? 'app-cloud-starting-screen-error' : ''}`}
      aria-live="polite"
      aria-busy={status === 'syncing'}
      aria-label={status === 'error' ? 'Cloud sync timed out' : 'Preparing Kordi Cloud'}
    >
      <div className="app-cloud-starting-dots" aria-hidden="true">
        <span className="app-cloud-starting-dot app-cloud-starting-dot-1" />
        <span className="app-cloud-starting-dot app-cloud-starting-dot-2" />
        <span className="app-cloud-starting-dot app-cloud-starting-dot-3" />
      </div>
    </div>
  );
}

function KordiAppShell() {
  useEffect(() => {
    void applyKordiMainWindowSize();
  }, []);

  const appShellFrameProps = useKordiAppModel();
  const { cloudInitialSync } = appShellFrameProps;
  if (cloudInitialSync.status !== 'ready') {
    return (
      <div className={`bridge-app ${appShellFrameProps.rootThemeClass}`}>
        <CloudStartingScreen
          status={cloudInitialSync.status === 'error' ? 'error' : 'syncing'}
          onRetry={cloudInitialSync.onRetry}
        />
      </div>
    );
  }
  return <AppShellFrame {...appShellFrameProps} />;
}

export default function KordiApp() {
  return <KordiAppRoot />;
}

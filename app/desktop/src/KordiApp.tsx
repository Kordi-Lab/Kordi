import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState, type MouseEventHandler } from 'react';

import { AppShellFrame } from '@/app/AppShellFrame';
import { readStoredThemeMode, resolveThemeMode } from '@/app/themePreference';
import { useKordiAppModel } from '@/app/useKordiAppModel';
import { shouldStartNativeWindowDrag } from '@/app/windowDrag';
import { shouldShowCloudLoginGate, type CloudSessionStatus } from '@/features/cloud/edition';
import { applyKordiMainWindowSize, isTauriRuntime } from '@/features/cloud/loginWindow';
import { useCloudSession, type UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { CloudLoginPage } from '@/kordi-app/cloud/CloudLoginPage';
import type { ResolvedThemeMode } from '@/kordi-app/types';

function readSystemTheme(): ResolvedThemeMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// The shell's useKordiUiEffects also writes `theme-*` to <body>, but it only
// runs after KordiAppShell mounts. Before that — on the cloud login gate and
// the restoring-session splash — nothing else applies a theme class, so the
// dark/light tokens never reach those screens. This hook syncs the body class
// to the persisted theme preference; `auto` follows system while the
// gate/splash is up. Once the shell mounts, its effect takes over.
function useGateThemeClass() {
  const [theme, setTheme] = useState<ResolvedThemeMode>(() => {
    const themeMode = readStoredThemeMode();
    return resolveThemeMode(themeMode, readSystemTheme());
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const themeMode = readStoredThemeMode();
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handle = () => {
      setTheme(resolveThemeMode(themeMode, mediaQuery.matches ? 'light' : 'dark'));
    };
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
  cloudSessionStatus,
  cloudSession,
}: KordiAppRootProps = {}) {
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
  const theme = useGateThemeClass();
  const handleGateWindowDragMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
    if (!shouldStartNativeWindowDrag({
      isNativeShell: isTauriRuntime(),
      button: event.button,
      clientY: event.clientY,
      shellTop: event.currentTarget.getBoundingClientRect().top,
      target: event.target,
    })) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startDragging().catch(() => undefined);
  };

  return (
    <div
      className={`bridge-app app-cloud-login-shell theme-${theme}`}
      onMouseDownCapture={handleGateWindowDragMouseDown}
    >
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
  if (shouldShowCloudLoginGate({ cloudSessionStatus: status })) {
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
  return <KordiAppShell cloudSession={cloudSessionOverride === undefined ? liveSession : undefined} />;
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

function KordiAppShell({ cloudSession }: { cloudSession?: UseCloudSessionResult }) {
  useEffect(() => {
    void applyKordiMainWindowSize();
  }, []);

  const appShellFrameProps = useKordiAppModel({ cloudSessionOverride: cloudSession });
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

import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState, type MouseEventHandler } from 'react';

import { AppShellFrame } from '@/app/AppShellFrame';
import { syncNativeWindowTheme } from '@/app/nativeWindowTheme';
import { readStoredThemeMode, resolveThemeMode } from '@/app/themePreference';
import { useKordiAppModel } from '@/app/useKordiAppModel';
import { CloudCallHost } from '@/features/cloud/CloudCallHost';
import { CloudCallProvider } from '@/features/cloud/CloudCallProvider';
import { shouldStartNativeWindowDrag } from '@/app/windowDrag';
import {
  clearNativeTextSelection,
  installCopySurfaceSelectionTracking,
  isEditableSelectionTarget,
  isSelectAllShortcut,
} from '@/features/contentSelection';
import { cloudAuthCapabilityDiscoveryEnabled } from '@/features/cloud/cloudAuthReleasePolicy';
import {
  dispatchCloudGroupInvitationAccepted,
  usePendingGroupInvitation,
} from '@/features/cloud/groupInvitationDeepLink';
import { shouldShowCloudLoginGate, type CloudSessionStatus } from '@/features/cloud/sessionGate';
import { applyKordiMainWindowSize, isTauriRuntime } from '@/features/cloud/loginWindow';
import { useCloudSession, type UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { WhatsNewLaunchWindow } from '@/features/updates/useWhatsNewWindow';
import { CloudLoginPage } from '@/kordi-app/cloud/CloudLoginPage';
import type { ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';
import { GroupInvitationDialog } from '@/pages/GroupInvitationDialog';

const SHOW_DEBUG_AUTH_DIAGNOSTICS = cloudAuthCapabilityDiscoveryEnabled();

type CloudSessionGateResult = Pick<
  UseCloudSessionResult,
  'status' | 'account' | 'signIn' | 'signUp' | 'signInWithProvider'
>;

function readSystemTheme(): ResolvedThemeMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function nativeWindowThemeIsResolvedTheme(theme: unknown): theme is ResolvedThemeMode {
  return theme === 'light' || theme === 'dark';
}

const GATE_WINDOW_BACKGROUND: Record<ResolvedThemeMode, string> = {
  light: '#f8fafc',
  dark: '#0f1115',
};

const APP_WINDOW_BACKGROUND: Record<ResolvedThemeMode, string> = {
  light: '#f4f1e7',
  dark: '#22231d',
};

// The shell's useKordiUiEffects also writes `theme-*` to <body>, but it only
// runs after KordiAppShell mounts. Before that — on the cloud login gate and
// the restoring-session splash — nothing else applies a theme class, so the
// dark/light tokens never reach those screens. This hook syncs the body class
// to the persisted theme preference; `auto` follows system while the
// gate/splash is up. Once the shell mounts, its effect takes over.
function useGateThemeClass() {
  const [themeMode] = useState<ThemeMode>(() => readStoredThemeMode());
  const [theme, setTheme] = useState<ResolvedThemeMode>(() => {
    return resolveThemeMode(themeMode, readSystemTheme());
  });

  useEffect(() => {
    let disposed = false;
    let unlistenNativeTheme: (() => void) | undefined;
    const mediaQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: light)')
      : null;
    const applySystemTheme = (systemTheme: ResolvedThemeMode) => {
      setTheme(resolveThemeMode(themeMode, systemTheme));
    };
    const handleMediaTheme = () => {
      if (!mediaQuery) return;
      applySystemTheme(mediaQuery.matches ? 'light' : 'dark');
    };

    if (themeMode === 'auto' && isTauriRuntime()) {
      void getCurrentWindow().theme()
        .then((nativeTheme) => {
          if (!disposed && nativeWindowThemeIsResolvedTheme(nativeTheme)) setTheme(nativeTheme);
        })
        .catch(() => {
          handleMediaTheme();
        });
      void getCurrentWindow().onThemeChanged(({ payload }) => {
        if (!disposed && nativeWindowThemeIsResolvedTheme(payload)) setTheme(payload);
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlistenNativeTheme = unlisten;
        })
        .catch(() => undefined);
    } else {
      handleMediaTheme();
    }

    mediaQuery?.addEventListener('change', handleMediaTheme);
    return () => {
      disposed = true;
      mediaQuery?.removeEventListener('change', handleMediaTheme);
      unlistenNativeTheme?.();
    };
  }, [themeMode]);

  useEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
    void syncNativeWindowTheme(themeMode).catch(() => undefined);
  }, [theme, themeMode]);

  useEffect(() => {
    document.body.classList.add('app-cloud-gate-active');
    if (isTauriRuntime()) {
      void getCurrentWindow().setBackgroundColor(GATE_WINDOW_BACKGROUND[theme]).catch(() => undefined);
    }

    return () => {
      document.body.classList.remove('app-cloud-gate-active');
      if (isTauriRuntime()) {
        void getCurrentWindow().setBackgroundColor(APP_WINDOW_BACKGROUND[theme]).catch(() => undefined);
      }
    };
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
  cloudSession?: CloudSessionGateResult;
};

export function KordiAppRoot({
  cloudSessionStatus,
  cloudSession,
}: KordiAppRootProps = {}) {
  useEffect(() => {
    const suppressUnscopedSelectAll = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || !isSelectAllShortcut(event)
        || isEditableSelectionTarget(event.target)
      ) return;
      event.preventDefault();
      clearNativeTextSelection();
    };
    const stopTrackingCopySelection = installCopySurfaceSelectionTracking(document);
    document.addEventListener('keydown', suppressUnscopedSelectAll);
    return () => {
      document.removeEventListener('keydown', suppressUnscopedSelectAll);
      stopTrackingCopySelection();
    };
  }, []);

  return (
    <CloudEditionRoot
      cloudSessionStatusOverride={cloudSessionStatus}
      cloudSessionOverride={cloudSession}
    />
  );
}

// Hosts whatever gate-time screen is showing (login form or restoring-session
// splash) inside the same `kordi-app` root the main shell uses, so the
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
      className={`kordi-app app-cloud-login-shell theme-${theme}`}
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
  cloudSessionOverride?: CloudSessionGateResult;
}) {
  const pendingGroupInvitation = usePendingGroupInvitation();
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
          showDebugAuthDiagnostics={SHOW_DEBUG_AUTH_DIAGNOSTICS}
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
  return (
    <KordiAppShell
      cloudSession={cloudSessionOverride === undefined ? liveSession : undefined}
      pendingGroupInvitation={pendingGroupInvitation}
    />
  );
}

export function CloudStartingScreen({
  status = 'syncing',
  onRetry,
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
      {status === 'error' && onRetry ? (
        <button
          type="button"
          className="app-cloud-starting-retry"
          onClick={onRetry}
        >
          Retry sync
        </button>
      ) : null}
    </div>
  );
}

function KordiAppShell({
  cloudSession,
  pendingGroupInvitation,
}: {
  cloudSession?: UseCloudSessionResult;
  pendingGroupInvitation: ReturnType<typeof usePendingGroupInvitation>;
}) {
  useEffect(() => {
    void applyKordiMainWindowSize();
  }, []);

  const appShellFrameProps = useKordiAppModel({ cloudSessionOverride: cloudSession });
  const { cloudInitialSync, cloudCalls, ...frameProps } = appShellFrameProps;
  if (cloudInitialSync.status !== 'ready') {
    return (
      <div className={`kordi-app ${appShellFrameProps.rootThemeClass}`}>
        <CloudStartingScreen
          status={cloudInitialSync.status === 'error' ? 'error' : 'syncing'}
          onRetry={cloudInitialSync.onRetry}
        />
      </div>
    );
  }
  return (
    <>
      <CloudCallProvider controller={cloudCalls}>
        <AppShellFrame
          {...frameProps}
          callOverlay={<CloudCallHost controller={cloudCalls} />}
        />
      </CloudCallProvider>
      <WhatsNewLaunchWindow />
      {pendingGroupInvitation.token ? (
        <GroupInvitationDialog
          key={pendingGroupInvitation.token}
          invitationToken={pendingGroupInvitation.token}
          onDismiss={pendingGroupInvitation.dismiss}
          onJoined={(result) => {
            dispatchCloudGroupInvitationAccepted(result);
            pendingGroupInvitation.dismiss();
          }}
        />
      ) : null}
    </>
  );
}

export default function KordiApp() {
  return <KordiAppRoot />;
}

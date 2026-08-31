import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useRef, useState, type MouseEventHandler } from 'react';

import { AppShellFrame } from '@/app/AppShellFrame';
import { syncNativeWindowTheme } from '@/app/nativeWindowTheme';
import { readStoredThemeMode, resolveThemeMode } from '@/app/themePreference';
import { useKordiAppModel } from '@/app/useKordiAppModel';
import { CloudCallHost } from '@/features/cloud/CloudCallHost';
import { CloudCallProvider } from '@/features/cloud/CloudCallProvider';
import {
  CALL_WINDOW_THUMBNAIL_EVENT,
  CALL_WINDOW_RESULT_EVENT,
  CALL_WINDOW_VISIBILITY_EVENT,
  openCallWindow,
  relayCallWindowState,
} from '@/features/cloud/callWindow';
import {
  CLOUD_CALLS_CHANGED_EVENT,
  type CloudCallsChangedDetail,
} from '@/features/cloud/cloudCalls';
import type { CloudCallsController } from '@/features/cloud/cloudCallController';
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
import type { Conversation } from '@/kordi-app/types';
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
  const detachedCallWindowEnabled = isTauriRuntime();
  const {
    cloudInitialSync,
    cloudCalls,
    callConversations,
    ...frameProps
  } = appShellFrameProps;
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
        <DetachedCallWindowLauncher
          controller={cloudCalls}
          conversations={callConversations}
          enabled={detachedCallWindowEnabled}
        />
        <AppShellFrame
          {...frameProps}
          callOverlay={(
            <CloudCallHost
              controller={cloudCalls}
              suppressCurrentSurface={detachedCallWindowEnabled}
            />
          )}
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

function DetachedCallWindowLauncher({
  controller,
  conversations,
  enabled,
}: {
  controller: CloudCallsController;
  conversations: readonly Conversation[];
  enabled: boolean;
}) {
  const openingCallIdRef = useRef<string | null>(null);
  const { detachedCall, setDetachedCallFolded, updateDetachedThumbnail } = controller;

  useEffect(() => {
    const current = controller.currentCall;
    const incoming = controller.incomingCall;
    const presented = current ?? incoming;
    const requiresAnswer = !current && Boolean(incoming);
    if (!enabled
      || !presented
      || !controller.account
      || controller.detachedCall
      || (current && !controller.isPresented)
      || (current
        && controller.phase !== 'connecting'
        && controller.phase !== 'ringing'
        && controller.phase !== 'connected'
        && controller.phase !== 'reconnecting')
      || openingCallIdRef.current === presented.call.id) return;
    const conversation = conversations.find((candidate) => (
      (candidate.canonicalSessionId || candidate.id) === presented.sessionId
    ));
    if (!conversation) return;
    openingCallIdRef.current = presented.call.id;
    void openCallWindow({
      account: controller.account,
      call: presented.call,
      sessionId: presented.sessionId,
      requiresAnswer,
      conversation: {
        id: conversation.id,
        canonicalSessionId: conversation.canonicalSessionId,
        name: conversation.name,
      },
    }, {
      onReady: async () => {
        if (requiresAnswer) controller.claimIncomingCallWindow(presented.call.id);
        else await controller.moveToWindow();
      },
      onDestroyed: () => {
        openingCallIdRef.current = null;
        controller.clearDetachedCall();
      },
    }).catch(() => {
      openingCallIdRef.current = null;
    });
  }, [controller, conversations, enabled]);

  useEffect(() => {
    if (!controller.account) return undefined;
    const handleCallState = (event: Event) => {
      const detail = (event as CustomEvent<CloudCallsChangedDetail>).detail;
      const callId = controller.detachedCall?.call.id ?? openingCallIdRef.current;
      if (!detail || detail.accountId !== controller.account?.accountId || !callId) return;
      const calls = detail.calls.filter((entry) => entry.call.id === callId);
      if (calls.length > 0) {
        void relayCallWindowState({ ...detail, calls });
      }
    };
    window.addEventListener(CLOUD_CALLS_CHANGED_EVENT, handleCallState);
    return () => window.removeEventListener(CLOUD_CALLS_CHANGED_EVENT, handleCallState);
  }, [controller.account, controller.detachedCall]);

  useEffect(() => {
    if (!detachedCall) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const unlistenThumbnail = await listen<{ dataUrl?: string }>(
        CALL_WINDOW_THUMBNAIL_EVENT,
        (event) => {
          const dataUrl = event.payload?.dataUrl;
          if (!disposed
            && typeof dataUrl === 'string'
            && dataUrl.startsWith('data:image/jpeg;base64,')
            && dataUrl.length < 200_000) {
            updateDetachedThumbnail(dataUrl);
          }
        },
      );
      const unlistenVisibility = await listen<{ folded?: boolean }>(
        CALL_WINDOW_VISIBILITY_EVENT,
        (event) => {
          if (!disposed && typeof event.payload?.folded === 'boolean') {
            setDetachedCallFolded(event.payload.folded);
          }
        },
      );
      const unlistenResult = await listen<CloudCallsChangedDetail>(
        CALL_WINDOW_RESULT_EVENT,
        (event) => {
          if (!disposed) {
            window.dispatchEvent(new CustomEvent(CLOUD_CALLS_CHANGED_EVENT, {
              detail: event.payload,
            }));
          }
        },
      );
      return () => {
        unlistenThumbnail();
        unlistenVisibility();
        unlistenResult();
      };
    }).then((nextUnlisten) => {
      if (disposed) nextUnlisten();
      else unlisten = nextUnlisten;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [detachedCall, setDetachedCallFolded, updateDetachedThumbnail]);

  return null;
}

export default function KordiApp() {
  return <KordiAppRoot />;
}

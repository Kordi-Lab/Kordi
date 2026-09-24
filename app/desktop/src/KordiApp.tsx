import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEventHandler } from 'react';

import { CloudStartingScreen } from '@/features/cloud/CloudStartingScreen';

import { AppShellFrame } from '@/app/AppShellFrame';
import { useNativeViewport } from '@/app/useNativeViewport';
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
import { isTauriRuntime, type CloudLoginMode } from '@/features/cloud/loginWindow';
import { readLoginModePreference } from '@/features/cloud/loginModePreference';
import { useCloudWindowSurface } from '@/features/cloud/useCloudWindowSurface';
import { useCloudSyncPresentation } from '@/features/cloud/useCloudSyncPresentation';
import { useCloudAuthTransition } from '@/features/cloud/useCloudAuthTransition';
import { useCloudSession, type UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { WhatsNewLaunchWindow } from '@/features/updates/useWhatsNewWindow';
import { CloudLoginPage } from '@/kordi-app/cloud/CloudLoginPage';
import type { ResolvedThemeMode, ThemeMode } from '@/kordi-app/types';
import type { Conversation } from '@/kordi-app/types';
import { GroupInvitationDialog } from '@/pages/GroupInvitationDialog';

export { CloudStartingScreen } from '@/features/cloud/CloudStartingScreen';

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
function useGateThemeClass(active: boolean) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredThemeMode());
  const [theme, setTheme] = useState<ResolvedThemeMode>(() => {
    return resolveThemeMode(themeMode, readSystemTheme());
  });

  const [previousActive, setPreviousActive] = useState(active);
  if (active !== previousActive) {
    setPreviousActive(active);
    if (active) {
      const nextMode = readStoredThemeMode();
      setThemeMode(nextMode);
      setTheme(resolveThemeMode(nextMode, readSystemTheme()));
    }
  }

  useEffect(() => {
    if (!active) return;
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
  }, [active, themeMode]);

  useLayoutEffect(() => {
    if (!active) return;
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
    void syncNativeWindowTheme(themeMode).catch(() => undefined);
  }, [active, theme, themeMode]);

  useLayoutEffect(() => {
    document.body.classList.toggle('app-cloud-gate-active', active);
    if (isTauriRuntime()) {
      const background = active ? GATE_WINDOW_BACKGROUND[theme] : APP_WINDOW_BACKGROUND[theme];
      void getCurrentWindow().setBackgroundColor(background).catch(() => undefined);
    }

    return () => {
      document.body.classList.remove('app-cloud-gate-active');
    };
  }, [active, theme]);

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
  useNativeViewport();
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
function CloudGateShell({ children, active = true }: { children: React.ReactNode; active?: boolean }) {
  const theme = useGateThemeClass(active);
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
      data-active={active}
      inert={!active}
      aria-hidden={!active}
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
  const { activity, signIn, signUp, socialSignIn, cancelSocialSignIn, signOut } = useCloudAuthTransition({
    ...session, signOut: liveSession.signOut,
  });
  const presentedSession = useMemo(() => ({ ...liveSession, signOut }), [liveSession, signOut]);
  const status: CloudSessionStatus = cloudSessionStatusOverride ?? session.status;
  const [loginMode, setLoginMode] = useState<CloudLoginMode>(() => readLoginModePreference() ?? 'login');
  const [sync, setSync] = useState<{ status: 'syncing' | 'error' | 'ready'; onRetry?: () => void }>({ status: 'syncing' });
  const [previousStatus, setPreviousStatus] = useState(status);
  const [loginPresented, setLoginPresented] = useState(false);
  if (previousStatus !== status) {
    setPreviousStatus(status);
    setSync({ status: 'syncing' });
    setLoginPresented(false);
  }
  const signedOut = shouldShowCloudLoginGate({ cloudSessionStatus: status });
  const windowReady = useCloudWindowSurface(signedOut ? loginMode : status === 'authenticated' ? 'main' : null);
  if (signedOut && windowReady && !loginPresented) setLoginPresented(true);
  const loginReady = (windowReady || loginPresented) && !activity;
  const gateActive = Boolean(activity) || status !== 'authenticated' || sync.status !== 'ready' || !windowReady;
  return (
    <>
      {status === 'authenticated' ? (
        <KordiAppShell
          cloudSession={cloudSessionOverride === undefined ? presentedSession : undefined}
          pendingGroupInvitation={pendingGroupInvitation}
          onSyncChange={setSync}
          windowReady={windowReady && !activity}
        />
      ) : null}
      <CloudGateShell active={gateActive}>
        <CloudStartingScreen
          visible={!(signedOut && loginReady)}
          status={status === 'authenticated' && sync.status === 'error' ? 'error' : 'syncing'}
          onRetry={sync.onRetry}
          onCancelSignIn={signedOut && activity === 'social-signing-in' ? cancelSocialSignIn : undefined}
        />
        {signedOut ? (
          <div className="app-cloud-login-surface" data-ready={loginReady} inert={!loginReady}>
            <CloudLoginPage
              initialMode={loginMode}
              onModeChange={setLoginMode}
              onSignIn={signIn}
              onSignUp={signUp}
              onSocialSignIn={socialSignIn}
              showDebugAuthDiagnostics={SHOW_DEBUG_AUTH_DIAGNOSTICS}
            />
          </div>
        ) : null}
      </CloudGateShell>
    </>
  );
}

function KordiAppShell({
  cloudSession,
  pendingGroupInvitation,
  onSyncChange,
  windowReady,
}: {
  cloudSession?: UseCloudSessionResult;
  pendingGroupInvitation: ReturnType<typeof usePendingGroupInvitation>;
  onSyncChange: (sync: { status: 'syncing' | 'error' | 'ready'; onRetry: () => void }) => void;
  windowReady: boolean;
}) {
  const appShellFrameProps = useKordiAppModel({ cloudSessionOverride: cloudSession });
  const detachedCallWindowEnabled = isTauriRuntime();
  const {
    cloudInitialSync,
    cloudCalls,
    callConversations,
    ...frameProps
  } = appShellFrameProps;
  useCloudSyncPresentation(cloudInitialSync, onSyncChange);
  if (cloudInitialSync.status !== 'ready') {
    return null;
  }
  return (
    <div className="app-cloud-workspace-surface" data-ready={windowReady} inert={!windowReady} aria-hidden={!windowReady}>
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
      {windowReady ? <WhatsNewLaunchWindow /> : null}
      {windowReady && pendingGroupInvitation.token ? (
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
    </div>
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

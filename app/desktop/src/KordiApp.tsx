import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CloudStartingScreen } from '@/features/cloud/CloudStartingScreen';
import { reopenCloudOAuthBrowser } from '@/features/cloud/cloudOAuthSignIn';

import { AppShellFrame } from '@/app/AppShellFrame';
import { useNativeViewport } from '@/app/useNativeViewport';
import { useKordiAppModel } from '@/app/useKordiAppModel';
import { CloudCallHost } from '@/features/cloud/CloudCallHost';
import { CloudCallProvider } from '@/features/cloud/CloudCallProvider';
import { CloudSafetyActionsProvider } from '@/features/safety/SafetyActionsProvider';
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
import { isTauriRuntime, supportsFrostedGate, type CloudLoginMode } from '@/features/cloud/loginWindow';
import { CloudGateShell } from '@/features/cloud/CloudGateShell';
import { readLoginModePreference } from '@/features/cloud/loginModePreference';
import { useCloudWindowSurface } from '@/features/cloud/useCloudWindowSurface';
import { useCloudSyncPresentation } from '@/features/cloud/useCloudSyncPresentation';
import { useCloudAuthTransition } from '@/features/cloud/useCloudAuthTransition';
import { useCloudSession, type UseCloudSessionResult } from '@/features/cloud/useCloudSession';
import { WhatsNewLaunchWindow } from '@/features/updates/useWhatsNewWindow';
import { CloudSignInGate } from '@/kordi-app/cloud/CloudSignInGate';
import type { Conversation } from '@/kordi-app/types';
import { GroupInvitationDialog } from '@/pages/GroupInvitationDialog';
import { DocumentShareLinkHost } from '@/features/documents/DocumentShareLinkDialog';

export { CloudStartingScreen } from '@/features/cloud/CloudStartingScreen';

const SHOW_DEBUG_AUTH_DIAGNOSTICS = cloudAuthCapabilityDiscoveryEnabled();

type CloudSessionGateResult = Pick<
  UseCloudSessionResult,
  'status' | 'account' | 'signIn' | 'signUp' | 'signInWithProvider' | 'browserSignIn'
>;

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
  const { activity, socialProvider, signIn, signUp, socialSignIn, cancelSocialSignIn, signOut } = useCloudAuthTransition({
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
  // Browser sign-in uses the compact welcome window until the server turns
  // out not to offer it; then the in-app form takes its own window size.
  const [inAppForm, setInAppForm] = useState(false);
  const handleBrowserSignInChange = useCallback((active: boolean) => setInAppForm(!active), []);
  const welcome = signedOut && Boolean(session.browserSignIn) && !inAppForm;
  const frosted = welcome && supportsFrostedGate();
  const windowReady = useCloudWindowSurface(signedOut ? (welcome ? 'welcome' : loginMode) : status === 'authenticated' ? 'main' : null);
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
      <CloudGateShell active={gateActive} frosted={frosted}>
        <CloudStartingScreen
          visible={!(signedOut && loginReady)}
          status={status === 'authenticated' && sync.status === 'error' ? 'error' : 'syncing'}
          onRetry={sync.onRetry}
          onCancelSignIn={signedOut && activity === 'social-signing-in' ? cancelSocialSignIn : undefined}
          onReopenSignIn={reopenCloudOAuthBrowser} signInProvider={socialProvider ?? undefined}
        />
        {signedOut ? (
          <div className="app-cloud-login-surface" data-ready={loginReady} inert={!loginReady}>
            <CloudSignInGate browserSignIn={session.browserSignIn}
              onBrowserSignInChange={handleBrowserSignInChange}
              initialMode={loginMode}
              onModeChange={setLoginMode}
              onSignIn={signIn}
              onSignUp={signUp}
              onRequestSignupCode={liveSession.requestSignupCode}
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
      <CloudSafetyActionsProvider account={cloudSession?.account ?? null}>
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
      </CloudSafetyActionsProvider>
      {windowReady ? <WhatsNewLaunchWindow /> : null}
      {windowReady ? <DocumentShareLinkHost account={cloudSession?.account ?? null} /> : null}
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

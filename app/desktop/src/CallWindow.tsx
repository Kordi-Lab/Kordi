import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PhoneIncoming, PhoneOff, Video } from 'lucide-react';

import { CloudCallHost } from '@/features/cloud/CloudCallHost';
import { CloudCallProvider } from '@/features/cloud/CloudCallProvider';
import { CallControlButton, CallIdentityStage } from '@/features/cloud/CloudCallSurfaceParts';
import {
  CALL_WINDOW_RESULT_EVENT,
  CALL_WINDOW_THUMBNAIL_EVENT,
  CALL_WINDOW_VISIBILITY_EVENT,
  callWindowSizeForVideo,
  callWindowRequestId,
  subscribeToCallWindow,
  type CallWindowPayload,
} from '@/features/cloud/callWindow';
import { CLOUD_CALLS_CHANGED_EVENT, type CloudCallsChangedDetail } from '@/features/cloud/cloudCalls';
import { useCloudCalls } from '@/features/cloud/useCloudCalls';

function captureRemoteVideoThumbnail(canvas: HTMLCanvasElement) {
  const video = document.querySelector<HTMLVideoElement>('.app-call-remote-video video');
  if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
  let dataUrl: string | null = null;
  if (video.readyState >= 2) {
    const context = canvas.getContext('2d');
    if (context) {
      const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      context.fillStyle = '#06080c';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      dataUrl = canvas.toDataURL('image/jpeg', 0.68);
    }
  }
  return {
    dataUrl,
    width: video.videoWidth,
    height: video.videoHeight,
  };
}

function isInitialPayload(
  payload: CallWindowPayload | CloudCallsChangedDetail,
): payload is CallWindowPayload {
  return 'requestId' in payload;
}

async function currentCallWindow() {
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  return getCurrentWebviewWindow();
}

export default function CallWindow() {
  const [requestId] = useState(callWindowRequestId);
  const [payload, setPayload] = useState<CallWindowPayload | null>(null);
  const [remoteAspectRatio, setRemoteAspectRatio] = useState<number | null>(null);
  const joiningCallIdRef = useRef<string | null>(null);
  const hadCurrentCallRef = useRef(false);
  const shownCallIdRef = useRef<string | null>(null);
  const windowSizeRef = useRef('');
  const controller = useCloudCalls({
    account: payload?.account ?? null,
    conversations: payload ? [payload.conversation] : [],
  });
  const windowController = useMemo(() => ({
    ...controller,
    minimize: () => {
      void import('@tauri-apps/api/event')
        .then(({ emit }) => emit(CALL_WINDOW_VISIBILITY_EVENT, { folded: true }))
        .then(() => currentCallWindow())
        .then((window) => window.hide());
    },
  }), [controller]);

  useEffect(() => {
    document.documentElement.classList.add('app-call-window-root');
    document.body.classList.add('app-call-window-root');
    return () => {
      document.documentElement.classList.remove('app-call-window-root');
      document.body.classList.remove('app-call-window-root');
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeToCallWindow(requestId, (next) => {
      if (disposed) return;
      if (isInitialPayload(next)) {
        setPayload(next);
        return;
      }
      window.dispatchEvent(new CustomEvent(CLOUD_CALLS_CHANGED_EVENT, { detail: next }));
    }).then((nextUnsubscribe) => {
      if (disposed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [requestId]);

  useEffect(() => {
    if (!payload
      || payload.requiresAnswer
      || joiningCallIdRef.current === payload.call.id) return;
    joiningCallIdRef.current = payload.call.id;
    void controller.join(payload.call, payload.sessionId);
  }, [controller, payload]);

  useEffect(() => {
    const current = controller.currentCall;
    if (!current
      || shownCallIdRef.current === current.call.id
      || (controller.phase !== 'ringing'
        && controller.phase !== 'connected'
        && controller.phase !== 'reconnecting')) return;
    shownCallIdRef.current = current.call.id;
    void currentCallWindow().then(async (window) => {
      await window.show();
      await window.setFocus();
    });
  }, [controller.currentCall, controller.phase]);

  useEffect(() => {
    if (controller.currentCall) {
      hadCurrentCallRef.current = true;
      return;
    }
    if (!hadCurrentCallRef.current) return;
    void currentCallWindow().then((window) => window.destroy());
  }, [controller.currentCall]);

  useEffect(() => {
    if (!controller.currentCall) return undefined;
    let disposed = false;
    let interval: number | undefined;
    let observer: MutationObserver | undefined;
    let observedVideo: HTMLVideoElement | null = null;
    let publishThumbnail: (() => void) | undefined;
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 135;
    void import('@tauri-apps/api/event').then(({ emit }) => {
      const publish = () => {
        const frame = captureRemoteVideoThumbnail(canvas);
        if (disposed || !frame) return;
        if (frame.dataUrl) {
          void emit(CALL_WINDOW_THUMBNAIL_EVENT, { requestId, dataUrl: frame.dataUrl });
        }
        const size = callWindowSizeForVideo(frame.width, frame.height);
        setRemoteAspectRatio(size.aspectRatio);
        const sizeKey = `${size.width}x${size.height}`;
        if (windowSizeRef.current === sizeKey) return;
        windowSizeRef.current = sizeKey;
        void Promise.all([
          currentCallWindow(),
          import('@tauri-apps/api/dpi'),
        ]).then(async ([callWindow, { LogicalSize }]) => {
          await callWindow.setSize(new LogicalSize(size.width, size.height));
          await callWindow.center();
        });
      };
      const attachVideoEvents = () => {
        const nextVideo = document.querySelector<HTMLVideoElement>('.app-call-remote-video video');
        if (nextVideo === observedVideo) return;
        observedVideo?.removeEventListener('loadedmetadata', publish);
        observedVideo?.removeEventListener('loadeddata', publish);
        observedVideo?.removeEventListener('resize', publish);
        observedVideo = nextVideo;
        observedVideo?.addEventListener('loadedmetadata', publish);
        observedVideo?.addEventListener('loadeddata', publish);
        observedVideo?.addEventListener('resize', publish);
        publish();
      };
      if (disposed) return;
      publishThumbnail = publish;
      observer = new MutationObserver(attachVideoEvents);
      observer.observe(document.body, { childList: true, subtree: true });
      attachVideoEvents();
      publish();
      interval = window.setInterval(publish, 1_000);
    });
    return () => {
      disposed = true;
      if (interval !== undefined) window.clearInterval(interval);
      observer?.disconnect();
      if (publishThumbnail) {
        observedVideo?.removeEventListener('loadedmetadata', publishThumbnail);
        observedVideo?.removeEventListener('loadeddata', publishThumbnail);
        observedVideo?.removeEventListener('resize', publishThumbnail);
      }
    };
  }, [controller.currentCall, requestId]);

  const pendingParticipant = payload?.call.participants.find(
    (participant) => participant.accountId !== payload.account.accountId,
  );
  const showPendingIdentity = Boolean(
    payload
      && !controller.currentCall
      && (payload.requiresAnswer || controller.phase !== 'idle'),
  );
  const answerIncomingCall = () => {
    if (!payload || joiningCallIdRef.current === payload.call.id) return;
    joiningCallIdRef.current = payload.call.id;
    void controller.join(payload.call, payload.sessionId);
  };
  const declineIncomingCall = () => {
    if (!payload) return;
    void controller.decline(payload.call, payload.sessionId).then(async (updated) => {
      if (!updated) return;
      const { emit } = await import('@tauri-apps/api/event');
      await emit(CALL_WINDOW_RESULT_EVENT, {
        accountId: payload.account.accountId,
        calls: [{ call: updated, sessionId: payload.sessionId }],
      } satisfies CloudCallsChangedDetail);
      const callWindow = await currentCallWindow();
      await callWindow.destroy();
    });
  };

  return (
    <main
      className="kordi-app theme-dark app-call-window-shell"
      data-video-orientation={remoteAspectRatio && remoteAspectRatio < 1 ? 'portrait' : 'landscape'}
      style={remoteAspectRatio
        ? { '--app-call-remote-aspect': remoteAspectRatio } as CSSProperties
        : undefined}
    >
      {!payload?.requiresAnswer || controller.currentCall ? (
        <CloudCallProvider controller={windowController}>
          <CloudCallHost controller={windowController} />
        </CloudCallProvider>
      ) : null}
      {showPendingIdentity && payload ? (
        <div className="app-call-window-pending">
          <CallIdentityStage
            accountId={pendingParticipant?.accountId || payload.call.id}
            name={pendingParticipant?.displayName || payload.conversation.name}
            avatarUrl={pendingParticipant?.avatarUrl ?? null}
            status={payload.requiresAnswer
              ? `Incoming ${payload.call.kind === 'voice' ? 'voice' : 'video'} call`
              : payload.call.state === 'ringing' ? 'Ringing…' : 'Connecting…'}
          />
          {payload.requiresAnswer ? (
            <div className="app-call-window-incoming-controls" aria-label="Incoming call controls">
              <CallControlButton
                label="Decline"
                ariaLabel="Decline call"
                tone="danger"
                onClick={declineIncomingCall}
              >
                <PhoneOff />
              </CallControlButton>
              <div className="app-call-window-answer-control">
                <CallControlButton
                  label="Answer"
                  ariaLabel="Answer call"
                  onClick={answerIncomingCall}
                >
                  {payload.call.kind === 'voice' ? <PhoneIncoming /> : <Video />}
                </CallControlButton>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

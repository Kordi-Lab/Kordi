import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { CloudCallHost } from '../../src/features/cloud/CloudCallHost';
import type { CloudCallsController } from '../../src/features/cloud/cloudCallController';

const call = {
  id: 'call-device-preview',
  revision: 1,
  conversationId: 'conversation-device-preview',
  kind: 'video' as const,
  state: 'active' as const,
  createdByAccountId: 'acct_self',
  createdAt: '2026-08-31T16:00:00Z',
  answeredAt: '2026-08-31T16:00:05Z',
  endedAt: null,
  participants: [
    { accountId: 'acct_self', displayName: 'You', avatarUrl: null, state: 'joined' as const },
    { accountId: 'acct_teammate', displayName: 'Example Teammate', avatarUrl: null, state: 'joined' as const },
  ],
};

const mediaDevices = [
  { deviceId: 'mic-built-in', kind: 'audioinput' as const, label: 'MacBook Pro Microphone' },
  { deviceId: 'mic-headset', kind: 'audioinput' as const, label: 'Wireless Headset' },
  { deviceId: 'speaker-built-in', kind: 'audiooutput' as const, label: 'MacBook Pro Speakers' },
  { deviceId: 'speaker-headset', kind: 'audiooutput' as const, label: 'Wireless Headset' },
  { deviceId: 'camera-built-in', kind: 'videoinput' as const, label: 'FaceTime HD Camera' },
];
const connectedAtMs = Date.now() - 5 * 60 * 1000;

function CallDevicePreview() {
  const isDetachedPreview = new URLSearchParams(window.location.search).get('mode') === 'detached';
  const [isMicrophoneEnabled, setIsMicrophoneEnabled] = useState(true);
  const [isCameraEnabled, setIsCameraEnabled] = useState(true);
  const [activeDeviceIds, setActiveDeviceIds] = useState<CloudCallsController['activeDeviceIds']>({
    audioinput: 'mic-headset',
    audiooutput: 'speaker-headset',
    videoinput: 'camera-built-in',
  });
  useEffect(() => {
    document.documentElement.classList.add('app-call-window-root');
    document.body.classList.add('app-call-window-root');
    if (!isDetachedPreview) {
      document.querySelector<HTMLButtonElement>('[aria-label="Choose call devices"]')?.click();
    }
    document.body.dataset.visualReady = 'true';
    return () => {
      document.documentElement.classList.remove('app-call-window-root');
      document.body.classList.remove('app-call-window-root');
    };
  }, [isDetachedPreview]);

  const controller: CloudCallsController = {
    account: {
      accountId: 'acct_self',
      displayName: 'You',
      primaryEmail: 'preview@example.com',
      avatarUrl: null,
      nodeId: null,
      passwordSet: true,
    },
    callsBySessionId: { 'session-device-preview': call },
    currentCall: isDetachedPreview ? null : { call, sessionId: 'session-device-preview' },
    incomingCall: null,
    handoffCall: null,
    detachedCall: isDetachedPreview ? { call, sessionId: 'session-device-preview' } : null,
    detachedThumbnailUrl: null,
    isDetachedCallFolded: isDetachedPreview,
    phase: 'connected',
    error: null,
    isPresented: !isDetachedPreview,
    isMicrophoneEnabled,
    isCameraEnabled,
    isAudioPlaybackBlocked: false,
    connectedAtMs,
    mediaParticipants: [
      {
        accountId: 'acct_self',
        name: 'You',
        avatarUrl: null,
        isLocal: true,
        isSpeaking: false,
        microphoneEnabled: isMicrophoneEnabled,
        cameraEnabled: isCameraEnabled,
        audioTrack: null,
        videoTrack: null,
      },
      {
        accountId: 'acct_teammate',
        name: 'Example Teammate',
        avatarUrl: null,
        isLocal: false,
        isSpeaking: true,
        microphoneEnabled: true,
        cameraEnabled: false,
        audioTrack: null,
        videoTrack: null,
      },
    ],
    mediaDevices,
    activeDeviceIds,
    canSelectAudioOutput: true,
    targetForConversation: () => null,
    callForConversation: () => call,
    start: async () => undefined,
    join: async () => undefined,
    decline: async () => null,
    leave: async () => undefined,
    end: async () => undefined,
    invite: async () => undefined,
    toggleMicrophone: async () => setIsMicrophoneEnabled((enabled) => !enabled),
    toggleCamera: async () => setIsCameraEnabled((enabled) => !enabled),
    resumeAudio: async () => undefined,
    refreshMediaDevices: async () => undefined,
    switchMediaDevice: async (kind, deviceId) => {
      setActiveDeviceIds((current) => ({ ...current, [kind]: deviceId }));
    },
    show: () => undefined,
    minimize: () => undefined,
    moveToWindow: async () => undefined,
    claimIncomingCallWindow: () => undefined,
    showWindow: async () => undefined,
    clearDetachedCall: () => undefined,
    setDetachedCallFolded: () => undefined,
    updateDetachedThumbnail: () => undefined,
    dismissError: () => undefined,
  };

  return (
    <main className="kordi-app theme-dark app-call-window-shell" data-video-orientation="portrait">
      <CloudCallHost controller={controller} />
    </main>
  );
}

createRoot(document.querySelector('#root')!).render(<CallDevicePreview />);

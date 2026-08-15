import type { CloudAccount } from './authClient';
import type { CloudCall, CloudCallKind } from './cloudCalls';
import { cloudCallTargetForConversation } from './cloudCalls';
import type { Conversation } from '@/kordi-app/types';

export type CloudCallPhase =
  | 'idle'
  | 'preparing'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export type CallMediaTrack = {
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(element: HTMLMediaElement): HTMLMediaElement;
};

export type CloudCallMediaParticipant = {
  accountId: string;
  name: string;
  avatarUrl: string | null;
  isLocal: boolean;
  isSpeaking: boolean;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  audioTrack: CallMediaTrack | null;
  videoTrack: CallMediaTrack | null;
};

export type CloudCallMediaDevice = {
  deviceId: string;
  kind: MediaDeviceKind;
  label: string;
};

export type PresentedCloudCall = {
  call: CloudCall;
  sessionId: string | null;
};

export type CurrentCallState = PresentedCloudCall & {
  direction: 'incoming' | 'outgoing' | 'handoff';
};

export type CloudCallsController = {
  account: CloudAccount | null;
  callsBySessionId: Readonly<Record<string, CloudCall>>;
  currentCall: PresentedCloudCall | null;
  incomingCall: PresentedCloudCall | null;
  handoffCall: PresentedCloudCall | null;
  phase: CloudCallPhase;
  error: string | null;
  isPresented: boolean;
  isMicrophoneEnabled: boolean;
  isCameraEnabled: boolean;
  isAudioPlaybackBlocked: boolean;
  connectedAtMs: number | null;
  mediaParticipants: CloudCallMediaParticipant[];
  mediaDevices: CloudCallMediaDevice[];
  activeDeviceIds: Partial<Record<MediaDeviceKind, string>>;
  canSelectAudioOutput: boolean;
  targetForConversation(conversation: Conversation): ReturnType<typeof cloudCallTargetForConversation>;
  callForConversation(conversation: Conversation): CloudCall | null;
  start(conversation: Conversation, kind: Exclude<CloudCallKind, 'meeting'>): Promise<void>;
  join(call: CloudCall, sessionId?: string | null): Promise<void>;
  decline(call: CloudCall, sessionId?: string | null): Promise<void>;
  leave(): Promise<void>;
  end(): Promise<void>;
  invite(): Promise<void>;
  toggleMicrophone(): Promise<void>;
  toggleCamera(): Promise<void>;
  resumeAudio(): Promise<void>;
  refreshMediaDevices(): Promise<void>;
  switchMediaDevice(kind: MediaDeviceKind, deviceId: string): Promise<void>;
  show(): void;
  minimize(): void;
  dismissError(): void;
};

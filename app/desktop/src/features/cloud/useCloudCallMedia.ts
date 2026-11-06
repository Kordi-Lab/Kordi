import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { Room } from 'livekit-client';

import {
  callConnectionErrorMessage,
  callMediaErrorMessage,
  type CloudCall,
} from './cloudCalls';
import type {
  CloudCallMediaDevice,
  CloudCallMediaParticipant,
  CloudCallPhase,
  CurrentCallState,
} from './cloudCallController';
import { canSwitchAudioOutput, mediaDeviceFallbackLabel } from './cloudCallState';
import {
  isMediaPermissionError,
  type CallMediaSource,
  type CallPermissionIssue,
} from './callMediaPermission';
import { isNativeDesktopShell } from '@/lib/desktop';

const mediaDeviceKinds: MediaDeviceKind[] = ['audioinput', 'audiooutput', 'videoinput'];

type UseCloudCallMediaInput = {
  operationRef: MutableRefObject<number>;
  currentRef: MutableRefObject<CurrentCallState | null>;
  setPhase: Dispatch<SetStateAction<CloudCallPhase>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setPermissionIssue?: Dispatch<SetStateAction<CallPermissionIssue | null>>;
};

export const callUsesAdaptiveVideo = (kind: CloudCall['kind']): boolean => kind === 'meeting';

export function useCloudCallMedia({
  operationRef,
  currentRef,
  setPhase,
  setError,
  setPermissionIssue,
}: UseCloudCallMediaInput) {
  // A device refused mid-call (for example access turned off in System
  // Settings) asks through the permission dialog instead of an error notice.
  const reportMediaError = useCallback((caught: unknown, sources: CallMediaSource[]) => {
    if (setPermissionIssue && isMediaPermissionError(caught)) {
      setPermissionIssue({ sources, canOpenSettings: isNativeDesktopShell() });
      return;
    }
    setError(callMediaErrorMessage(caught));
  }, [setError, setPermissionIssue]);
  const [isMicrophoneEnabled, setIsMicrophoneEnabled] = useState(true);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);
  const [isAudioPlaybackBlocked, setIsAudioPlaybackBlocked] = useState(false);
  const [connectedAtMs, setConnectedAtMs] = useState<number | null>(null);
  const [mediaParticipants, setMediaParticipants] = useState<CloudCallMediaParticipant[]>([]);
  const [mediaDevices, setMediaDevices] = useState<CloudCallMediaDevice[]>([]);
  const [activeDeviceIds, setActiveDeviceIds] = useState<Partial<Record<MediaDeviceKind, string>>>({});
  const roomRef = useRef<Room | null>(null);
  const [disconnectedOperation, setDisconnectedOperation] = useState<number | null>(null);

  const clearRoom = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    setDisconnectedOperation(null);
    try {
      await room?.disconnect(true);
    } finally {
      setMediaParticipants([]);
      setConnectedAtMs(null);
      setIsMicrophoneEnabled(true);
      setIsCameraEnabled(false);
      setIsAudioPlaybackBlocked(false);
      setActiveDeviceIds({});
    }
  }, []);

  const refreshMediaDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const positions: Partial<Record<MediaDeviceKind, number>> = {};
      setMediaDevices(devices.flatMap((device) => {
        if (!mediaDeviceKinds.includes(device.kind)) return [];
        const position = (positions[device.kind] ?? 0) + 1;
        positions[device.kind] = position;
        return [{
          deviceId: device.deviceId,
          kind: device.kind,
          label: device.label.trim() || mediaDeviceFallbackLabel(device.kind, position),
        }];
      }));
      const room = roomRef.current;
      if (room) {
        setActiveDeviceIds(Object.fromEntries(mediaDeviceKinds.map(kind => [kind, room.getActiveDevice(kind)])));
      }
    } catch {
      setError('Kordi could not read the media devices on this Mac. Check System Settings and try again.');
    }
  }, [setError]);

  const rebuildMediaParticipants = useCallback(async (room: Room) => {
    const { Track } = await import('livekit-client');
    if (roomRef.current !== room) return;
    const participants = [room.localParticipant, ...room.remoteParticipants.values()];
    const call = currentRef.current?.call;
    setMediaParticipants(participants.map((participant) => {
      const callProfile = call?.participants.find((entry) => entry.accountId === participant.identity);
      const cameraPublication = participant.getTrackPublication(Track.Source.Camera);
      const microphonePublication = participant.getTrackPublication(Track.Source.Microphone);
      return {
        accountId: participant.identity,
        name: participant.name?.trim() || callProfile?.displayName || 'Kordi user',
        avatarUrl: callProfile?.avatarUrl ?? null,
        isLocal: participant.isLocal,
        isSpeaking: participant.isSpeaking,
        microphoneEnabled: participant.isMicrophoneEnabled,
        cameraEnabled: participant.isCameraEnabled,
        audioTrack: microphonePublication?.audioTrack ?? null,
        videoTrack: cameraPublication?.videoTrack ?? null,
      };
    }));
  }, [currentRef]);

  const connectMedia = useCallback(async (
    session: { call: CloudCall; media: { url: string; token: string } },
    nextCurrent: CurrentCallState,
    operation: number,
  ) => {
    const { Room: LiveKitRoom, RoomEvent, VideoPresets } = await import('livekit-client');
    if (operationRef.current !== operation) return;
    const room = new LiveKitRoom({
      adaptiveStream: callUsesAdaptiveVideo(session.call.kind),
      dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h1080.resolution },
    });
    roomRef.current = room;
    currentRef.current = nextCurrent;
    const refresh = () => { void rebuildMediaParticipants(room); };
    const isCurrentRoom = () => roomRef.current === room && operationRef.current === operation;
    const markConnected = () => {
      if (!isCurrentRoom()) return;
      setPhase('connected');
      setConnectedAtMs((value) => value ?? Date.now());
      refresh();
    };
    room.on(RoomEvent.Reconnecting, () => { if (isCurrentRoom()) setPhase('reconnecting'); });
    room.on(RoomEvent.Reconnected, () => {
      if (isCurrentRoom()) setError(null);
      markConnected();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (roomRef.current !== room) return;
      roomRef.current = null;
      // Media teardown can arrive before the call-ended sync event. Reconcile
      // the authoritative call state before presenting a connection failure.
      setPhase('reconnecting');
      setDisconnectedOperation(operation);
      setMediaParticipants([]);
    });
    room.on(RoomEvent.ParticipantConnected, markConnected);
    for (const event of [
      RoomEvent.ParticipantDisconnected, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished, RoomEvent.ActiveSpeakersChanged,
    ]) room.on(event, refresh);
    room.on(RoomEvent.TrackSubscriptionFailed, () => {
      if (!isCurrentRoom()) return;
      setError('A remote camera or microphone track could not be subscribed.');
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
      if (!isCurrentRoom()) return;
      setIsAudioPlaybackBlocked(!playing || !room.canPlaybackAudio);
    });
    room.on(RoomEvent.MediaDevicesError, (mediaError) => {
      if (!isCurrentRoom()) return;
      const sources: CallMediaSource[] = currentRef.current?.call.kind === 'voice' ? ['microphone'] : ['microphone', 'camera'];
      reportMediaError(mediaError, sources);
    });
    try {
      await room.connect(session.media.url, session.media.token);
    } catch (caught) {
      throw new Error(callConnectionErrorMessage(caught));
    }
    if (!isCurrentRoom()) {
      await room.disconnect(true);
      return;
    }
    try {
      await room.startAudio();
      setIsAudioPlaybackBlocked(!room.canPlaybackAudio);
    } catch {
      setIsAudioPlaybackBlocked(true);
    }
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch {
      throw new Error('Microphone publication failed. Check microphone access and try again.');
    }
    if (session.call.kind !== 'voice') {
      try {
        await room.localParticipant.setCameraEnabled(true);
      } catch {
        throw new Error('Camera publication failed. Check camera access and try again.');
      }
      if (!isCurrentRoom()) return;
      setIsCameraEnabled(true);
    }
    if (!isCurrentRoom()) return;
    setIsMicrophoneEnabled(true);
    await refreshMediaDevices();
    if (!isCurrentRoom()) return;
    const connected = session.call.kind === 'meeting'
      || session.call.state === 'active'
      || room.remoteParticipants.size > 0;
    setPhase(connected ? 'connected' : 'ringing');
    if (connected) setConnectedAtMs(Date.parse(session.call.answeredAt ?? '') || Date.now());
    await rebuildMediaParticipants(room);
  }, [currentRef, operationRef, rebuildMediaParticipants, refreshMediaDevices, reportMediaError, setError, setPhase]);

  const toggleMicrophone = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const enabled = !isMicrophoneEnabled;
      await room.localParticipant.setMicrophoneEnabled(enabled);
      setIsMicrophoneEnabled(enabled);
      await rebuildMediaParticipants(room);
    } catch (caught) {
      reportMediaError(caught, ['microphone']);
    }
  }, [isMicrophoneEnabled, rebuildMediaParticipants, reportMediaError]);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room || currentRef.current?.call.kind === 'voice') return;
    try {
      const enabled = !isCameraEnabled;
      await room.localParticipant.setCameraEnabled(enabled);
      setIsCameraEnabled(enabled);
      await rebuildMediaParticipants(room);
    } catch (caught) {
      reportMediaError(caught, ['camera']);
    }
  }, [currentRef, isCameraEnabled, rebuildMediaParticipants, reportMediaError]);

  const resumeAudio = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.startAudio();
      setIsAudioPlaybackBlocked(!room.canPlaybackAudio);
    } catch {
      setIsAudioPlaybackBlocked(true);
      setError('Select Start audio again to hear the other participants.');
    }
  }, [setError]);

  const switchMediaDevice = useCallback(async (kind: MediaDeviceKind, deviceId: string) => {
    const room = roomRef.current;
    if (!room || !deviceId) return;
    if (kind === 'audiooutput' && !canSwitchAudioOutput()) {
      setError('Speaker selection uses the output chosen in macOS System Settings on this Mac.');
      return;
    }
    try {
      const switched = await room.switchActiveDevice(kind, deviceId);
      if (!switched) throw new Error('device switch was not applied');
      setActiveDeviceIds((currentIds) => ({ ...currentIds, [kind]: deviceId }));
      await rebuildMediaParticipants(room);
      await refreshMediaDevices();
    } catch {
      const deviceName = kind === 'audioinput'
        ? 'microphone'
        : kind === 'audiooutput' ? 'speaker' : 'camera';
      setError(`Kordi could not switch the ${deviceName}. Check macOS permissions and try again.`);
    }
  }, [rebuildMediaParticipants, refreshMediaDevices, setError]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return undefined;
    const handleDeviceChange = () => { void refreshMediaDevices(); };
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, [refreshMediaDevices]);

  useEffect(() => () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) void room.disconnect(true);
  }, []);

  return {
    roomRef,
    disconnectedOperation,
    clearRoom,
    connectMedia,
    refreshMediaDevices,
    toggleMicrophone,
    toggleCamera,
    resumeAudio,
    switchMediaDevice,
    setMediaDevices,
    isMicrophoneEnabled,
    isCameraEnabled,
    isAudioPlaybackBlocked,
    connectedAtMs,
    mediaParticipants,
    mediaDevices,
    activeDeviceIds,
    canSelectAudioOutput: canSwitchAudioOutput(),
  };
}

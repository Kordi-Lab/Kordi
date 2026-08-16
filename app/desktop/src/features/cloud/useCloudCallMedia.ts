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

import { callMediaErrorMessage, type CloudCall } from './cloudCalls';
import type {
  CloudCallMediaDevice,
  CloudCallMediaParticipant,
  CloudCallPhase,
  CurrentCallState,
} from './cloudCallController';
import { canSwitchAudioOutput, mediaDeviceFallbackLabel } from './cloudCallState';

type UseCloudCallMediaInput = {
  operationRef: MutableRefObject<number>;
  currentRef: MutableRefObject<CurrentCallState | null>;
  setPhase: Dispatch<SetStateAction<CloudCallPhase>>;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function useCloudCallMedia({
  operationRef,
  currentRef,
  setPhase,
  setError,
}: UseCloudCallMediaInput) {
  const [isMicrophoneEnabled, setIsMicrophoneEnabled] = useState(true);
  const [isCameraEnabled, setIsCameraEnabled] = useState(false);
  const [isAudioPlaybackBlocked, setIsAudioPlaybackBlocked] = useState(false);
  const [connectedAtMs, setConnectedAtMs] = useState<number | null>(null);
  const [mediaParticipants, setMediaParticipants] = useState<CloudCallMediaParticipant[]>([]);
  const [mediaDevices, setMediaDevices] = useState<CloudCallMediaDevice[]>([]);
  const [activeDeviceIds, setActiveDeviceIds] = useState<Partial<Record<MediaDeviceKind, string>>>({});
  const roomRef = useRef<Room | null>(null);
  const expectedDisconnectRef = useRef(false);

  const clearMediaDevices = useCallback(() => {
    setMediaDevices([]);
  }, []);

  const clearRoom = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    expectedDisconnectRef.current = true;
    try {
      await room?.disconnect(true);
    } finally {
      expectedDisconnectRef.current = false;
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
        if (device.kind !== 'audioinput'
          && device.kind !== 'audiooutput'
          && device.kind !== 'videoinput') return [];
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
        setActiveDeviceIds({
          audioinput: room.getActiveDevice('audioinput'),
          audiooutput: room.getActiveDevice('audiooutput'),
          videoinput: room.getActiveDevice('videoinput'),
        });
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
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    });
    roomRef.current = room;
    currentRef.current = nextCurrent;
    const refresh = () => { void rebuildMediaParticipants(room); };
    room.on(RoomEvent.Reconnecting, () => setPhase('reconnecting'));
    room.on(RoomEvent.Reconnected, () => {
      setPhase('connected');
      setConnectedAtMs((value) => value ?? Date.now());
      refresh();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (roomRef.current !== room || expectedDisconnectRef.current) return;
      roomRef.current = null;
      setPhase('failed');
      setError('The call disconnected. Check your connection and try joining again.');
      setMediaParticipants([]);
    });
    room.on(RoomEvent.ParticipantConnected, () => {
      setPhase('connected');
      setConnectedAtMs((value) => value ?? Date.now());
      refresh();
    });
    room.on(RoomEvent.ParticipantDisconnected, refresh);
    room.on(RoomEvent.TrackSubscribed, refresh);
    room.on(RoomEvent.TrackUnsubscribed, refresh);
    room.on(RoomEvent.TrackMuted, refresh);
    room.on(RoomEvent.TrackUnmuted, refresh);
    room.on(RoomEvent.LocalTrackPublished, refresh);
    room.on(RoomEvent.LocalTrackUnpublished, refresh);
    room.on(RoomEvent.ActiveSpeakersChanged, refresh);
    room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
      setIsAudioPlaybackBlocked(!playing || !room.canPlaybackAudio);
    });
    room.on(RoomEvent.MediaDevicesError, (mediaError) => setError(callMediaErrorMessage(mediaError)));
    await room.connect(session.media.url, session.media.token);
    if (operationRef.current !== operation) {
      await room.disconnect(true);
      return;
    }
    try {
      await room.startAudio();
      setIsAudioPlaybackBlocked(!room.canPlaybackAudio);
    } catch {
      setIsAudioPlaybackBlocked(true);
    }
    await room.localParticipant.setMicrophoneEnabled(true);
    if (session.call.kind !== 'voice') {
      await room.localParticipant.setCameraEnabled(true);
      setIsCameraEnabled(true);
    }
    setIsMicrophoneEnabled(true);
    await refreshMediaDevices();
    const connected = session.call.kind === 'meeting'
      || session.call.state === 'active'
      || room.remoteParticipants.size > 0;
    setPhase(connected ? 'connected' : 'ringing');
    if (connected) setConnectedAtMs(Date.parse(session.call.answeredAt ?? '') || Date.now());
    await rebuildMediaParticipants(room);
  }, [currentRef, operationRef, rebuildMediaParticipants, refreshMediaDevices, setError, setPhase]);

  const toggleMicrophone = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const enabled = !isMicrophoneEnabled;
      await room.localParticipant.setMicrophoneEnabled(enabled);
      setIsMicrophoneEnabled(enabled);
      await rebuildMediaParticipants(room);
    } catch (caught) {
      setError(callMediaErrorMessage(caught));
    }
  }, [isMicrophoneEnabled, rebuildMediaParticipants, setError]);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room || currentRef.current?.call.kind === 'voice') return;
    try {
      const enabled = !isCameraEnabled;
      await room.localParticipant.setCameraEnabled(enabled);
      setIsCameraEnabled(enabled);
      await rebuildMediaParticipants(room);
    } catch (caught) {
      setError(callMediaErrorMessage(caught));
    }
  }, [currentRef, isCameraEnabled, rebuildMediaParticipants, setError]);

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
    clearRoom,
    connectMedia,
    refreshMediaDevices,
    toggleMicrophone,
    toggleCamera,
    resumeAudio,
    switchMediaDevice,
    clearMediaDevices,
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

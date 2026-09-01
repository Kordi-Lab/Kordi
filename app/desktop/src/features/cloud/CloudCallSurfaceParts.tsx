import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import {
  Camera,
  Check,
  Mic,
  MicOff,
  Volume2,
} from 'lucide-react';

import type {
  CallMediaTrack,
  CloudCallMediaDevice,
  CloudCallMediaParticipant,
  CloudCallsController,
} from './cloudCallController';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';

function AttachedVideo({
  track,
  muted,
}: {
  track: CallMediaTrack;
  muted: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

export function AttachedAudio({ track }: { track: CallMediaTrack }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

export function CallParticipantTile({
  participant,
  className,
}: {
  participant: CloudCallMediaParticipant;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'app-call-participant-tile',
        participant.isSpeaking && 'app-call-participant-speaking',
        className,
      )}
      data-local-participant={participant.isLocal ? 'true' : undefined}
    >
      {participant.cameraEnabled && participant.videoTrack ? (
        <AttachedVideo track={participant.videoTrack} muted={participant.isLocal} />
      ) : (
        <IdentityAvatar
          kind="human"
          seed={participant.accountId}
          isSelf={participant.isLocal}
          name={participant.name}
          imageUrl={participant.avatarUrl}
          className="app-call-participant-avatar"
        />
      )}
      <div className="app-call-participant-label">
        <span>{participant.isLocal ? 'You' : participant.name}</span>
        {!participant.microphoneEnabled ? <MicOff aria-label="Microphone off" /> : null}
      </div>
    </div>
  );
}

export function CallIdentityStage({
  accountId,
  name,
  avatarUrl,
  status,
}: {
  accountId: string;
  name: string;
  avatarUrl: string | null;
  status: string;
}) {
  return (
    <div className="app-call-identity-stage">
      <div className="app-call-identity-avatar-shell">
        <IdentityAvatar
          kind="human"
          seed={accountId}
          name={name}
          imageUrl={avatarUrl}
          className="app-call-identity-avatar"
        />
      </div>
      <h3>{name}</h3>
      <p>
        <span className="app-call-wave" aria-hidden="true"><i /><i /><i /></span>
        <span>{status}</span>
      </p>
    </div>
  );
}

export function CallControlButton({
  label,
  ariaLabel,
  selected,
  tone,
  expanded,
  onClick,
  children,
}: {
  label: string;
  ariaLabel: string;
  selected?: boolean;
  tone?: 'danger';
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn('app-call-control', tone === 'danger' && 'app-call-control-danger')}
      data-selected={selected ? 'true' : undefined}
      aria-label={ariaLabel}
      aria-pressed={typeof selected === 'boolean' ? selected : undefined}
      aria-expanded={typeof expanded === 'boolean' ? expanded : undefined}
      title={ariaLabel}
      onClick={onClick}
    >
      <span className="app-call-control-disc">{children}</span>
      <span className="app-call-control-label">{label}</span>
    </button>
  );
}

function deviceKindTitle(kind: MediaDeviceKind): string {
  if (kind === 'audioinput') return 'Microphone';
  if (kind === 'audiooutput') return 'Speaker';
  return 'Camera';
}

function deviceKindIcon(kind: MediaDeviceKind): ReactNode {
  if (kind === 'audioinput') return <Mic aria-hidden="true" />;
  if (kind === 'audiooutput') return <Volume2 aria-hidden="true" />;
  return <Camera aria-hidden="true" />;
}

function CallDeviceGroup({
  kind,
  devices,
  activeDeviceId,
  disabled,
  onSelect,
}: {
  kind: MediaDeviceKind;
  devices: CloudCallMediaDevice[];
  activeDeviceId: string | undefined;
  disabled?: boolean;
  onSelect: (kind: MediaDeviceKind, deviceId: string) => void;
}) {
  return (
    <section className="app-call-device-group" aria-label={deviceKindTitle(kind)}>
      <h4>{deviceKindTitle(kind)}</h4>
      {disabled ? (
        <p className="app-call-device-system-note">Uses the output selected in macOS System Settings.</p>
      ) : devices.length > 0 ? devices.map((device, index) => {
        const isActive = activeDeviceId
          ? activeDeviceId === device.deviceId
          : index === 0;
        return (
          <button
            key={`${kind}:${device.deviceId || index}`}
            type="button"
            className="app-call-device-option"
            aria-pressed={isActive}
            onClick={() => onSelect(kind, device.deviceId)}
          >
            <span className="app-call-device-icon">{deviceKindIcon(kind)}</span>
            <span>{device.label}</span>
            {isActive ? <Check aria-label="Active device" /> : null}
          </button>
        );
      }) : (
        <p className="app-call-device-system-note">No device is currently available.</p>
      )}
    </section>
  );
}

export function CallDeviceMenu({
  controller,
  includesCamera,
}: {
  controller: CloudCallsController;
  includesCamera: boolean;
}) {
  const selectDevice = useCallback((kind: MediaDeviceKind, deviceId: string) => {
    void controller.switchMediaDevice(kind, deviceId);
  }, [controller]);
  const devicesForKind = (kind: MediaDeviceKind) => controller.mediaDevices
    .filter((device) => device.kind === kind);
  return (
    <div className="app-call-device-menu" role="dialog" aria-label="Call devices">
      <div className="app-call-device-menu-heading">
        <strong>Call devices</strong>
      </div>
      <CallDeviceGroup
        kind="audioinput"
        devices={devicesForKind('audioinput')}
        activeDeviceId={controller.activeDeviceIds.audioinput}
        onSelect={selectDevice}
      />
      <CallDeviceGroup
        kind="audiooutput"
        devices={devicesForKind('audiooutput')}
        activeDeviceId={controller.activeDeviceIds.audiooutput}
        disabled={!controller.canSelectAudioOutput}
        onSelect={selectDevice}
      />
      {includesCamera ? (
        <CallDeviceGroup
          kind="videoinput"
          devices={devicesForKind('videoinput')}
          activeDeviceId={controller.activeDeviceIds.videoinput}
          onSelect={selectDevice}
        />
      ) : null}
    </div>
  );
}

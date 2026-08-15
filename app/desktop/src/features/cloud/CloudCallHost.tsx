import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  Camera,
  CameraOff,
  Mic,
  MicOff,
  Minimize2,
  PhoneIncoming,
  PhoneOff,
  RefreshCw,
  Users,
  Video,
  Volume2,
  X,
} from 'lucide-react';

import {
  AttachedAudio,
  CallControlButton,
  CallDeviceMenu,
  CallIdentityStage,
  CallParticipantTile,
} from './CloudCallSurfaceParts';
import {
  callKindLabel,
  callParticipants,
  callTitle,
  otherParticipant,
  participantName,
  phaseLabel,
  recoveryContent,
  useCallDialogFocus,
  useCallDuration,
} from './cloudCallSurfaceSupport';
import type { CloudCallsController } from './cloudCallController';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';

function CallSurface({ controller }: { controller: CloudCallsController }) {
  const current = controller.currentCall;
  const duration = useCallDuration(controller.connectedAtMs);
  const [isDeviceMenuOpen, setIsDeviceMenuOpen] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const deviceAnchorRef = useRef<HTMLDivElement | null>(null);
  const handleEscape = useCallback(() => {
    if (isDeviceMenuOpen) {
      setIsDeviceMenuOpen(false);
      return;
    }
    controller.minimize();
  }, [controller, isDeviceMenuOpen]);
  useCallDialogFocus(dialogRef, handleEscape);
  useEffect(() => {
    if (!isDeviceMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!deviceAnchorRef.current?.contains(event.target as Node)) setIsDeviceMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isDeviceMenuOpen]);
  const participants = useMemo(() => current
    ? callParticipants(current.call, controller.mediaParticipants, controller.account?.accountId)
    : [], [controller.account?.accountId, controller.mediaParticipants, current]);
  if (!current) return null;
  const { call } = current;
  const title = callTitle(call, controller.account?.accountId);
  const isVideoCall = call.kind !== 'voice';
  const isMeeting = call.kind === 'meeting';
  const canEndForEveryone = !isMeeting
    || call.createdByAccountId === controller.account?.accountId;
  const remoteParticipant = participants.find((participant) => !participant.isLocal);
  const localParticipant = participants.find((participant) => participant.isLocal);
  const remoteProfile = otherParticipant(call, controller.account?.accountId);
  const status = duration ? `${phaseLabel(controller)} · ${duration}` : phaseLabel(controller);
  const recovery = controller.error ? recoveryContent(controller.error, controller.phase) : null;
  const toggleDeviceMenu = () => {
    setIsDeviceMenuOpen((open) => {
      if (!open) void controller.refreshMediaDevices();
      return !open;
    });
  };

  return (
    <div className="app-call-overlay">
      <section
        ref={dialogRef}
        className="app-call-surface"
        role="dialog"
        aria-modal="true"
        aria-label={`${title} call`}
        tabIndex={-1}
      >
        <header className="app-call-surface-header">
          <div className="app-call-surface-heading">
            <h2>{title}</h2>
            <p role="status" aria-live="polite">
              <span className="app-call-phase-dot" data-phase={controller.phase} aria-hidden="true" />
              <span>{status}</span>
            </p>
          </div>
          <span className="app-call-surface-kind">{isMeeting ? 'Kordi meeting' : 'Kordi call'}</span>
          <div className="app-call-surface-actions">
            <button
              type="button"
              className="app-call-icon-button"
              onClick={() => controller.minimize()}
              aria-label="Minimize call"
              title="Minimize call"
            >
              <Minimize2 />
            </button>
          </div>
        </header>

        {isMeeting ? (
          <div className="app-call-participant-grid" data-participant-count={Math.min(participants.length, 4)}>
            {participants.length > 0 ? participants.map((participant) => (
              <CallParticipantTile key={participant.accountId} participant={participant} />
            )) : (
              <CallIdentityStage
                accountId={remoteProfile?.accountId || call.id}
                name={title}
                avatarUrl={remoteProfile?.avatarUrl ?? null}
                status="Waiting for others to join…"
              />
            )}
          </div>
        ) : (
          <div className="app-call-direct-stage">
            {isVideoCall && remoteParticipant?.cameraEnabled && remoteParticipant.videoTrack ? (
              <CallParticipantTile participant={remoteParticipant} className="app-call-remote-video" />
            ) : (
              <CallIdentityStage
                accountId={remoteParticipant?.accountId || remoteProfile?.accountId || call.id}
                name={remoteParticipant?.name || title}
                avatarUrl={remoteParticipant?.avatarUrl ?? remoteProfile?.avatarUrl ?? null}
                status={controller.phase === 'failed' ? 'Keeping the call open…' : phaseLabel(controller)}
              />
            )}
            {isVideoCall && localParticipant ? (
              <CallParticipantTile participant={localParticipant} className="app-call-local-preview" />
            ) : null}
          </div>
        )}

        {recovery ? (
          <div className="app-call-recovery" role="alert">
            <span className="app-call-recovery-icon"><AlertTriangle aria-hidden="true" /></span>
            <span className="app-call-recovery-copy">
              <strong>{recovery.title}</strong>
              <span>{recovery.description}</span>
            </span>
            {controller.phase === 'failed' ? (
              <button
                type="button"
                className="app-call-recovery-action"
                onClick={() => { void controller.join(call, current.sessionId); }}
              >
                Try again
              </button>
            ) : null}
            <button
              type="button"
              className="app-call-recovery-dismiss"
              onClick={() => controller.dismissError()}
              aria-label="Dismiss call notice"
            >
              <X />
            </button>
          </div>
        ) : null}

        {controller.isAudioPlaybackBlocked ? (
          <div className="app-call-recovery" role="alert">
            <span className="app-call-recovery-icon"><Volume2 aria-hidden="true" /></span>
            <span className="app-call-recovery-copy">
              <strong>Audio is paused</strong>
              <span>macOS needs one click before Kordi can play the other participants.</span>
            </span>
            <button
              type="button"
              className="app-call-recovery-action"
              onClick={() => { void controller.resumeAudio(); }}
            >
              Start audio
            </button>
          </div>
        ) : null}

        <footer className="app-call-controls" aria-label="Call controls">
          <CallControlButton
            label={controller.isMicrophoneEnabled ? 'Mute' : 'Unmute'}
            ariaLabel={controller.isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
            selected={!controller.isMicrophoneEnabled}
            onClick={() => { void controller.toggleMicrophone(); }}
          >
            {controller.isMicrophoneEnabled ? <Mic /> : <MicOff />}
          </CallControlButton>
          {isVideoCall ? (
            <CallControlButton
              label={controller.isCameraEnabled ? 'Camera' : 'Camera off'}
              ariaLabel={controller.isCameraEnabled ? 'Turn camera off' : 'Turn camera on'}
              selected={!controller.isCameraEnabled}
              onClick={() => { void controller.toggleCamera(); }}
            >
              {controller.isCameraEnabled ? <Camera /> : <CameraOff />}
            </CallControlButton>
          ) : null}
          <div ref={deviceAnchorRef} className="app-call-device-anchor">
            <CallControlButton
              label="Audio"
              ariaLabel="Choose call devices"
              expanded={isDeviceMenuOpen}
              onClick={toggleDeviceMenu}
            >
              <Volume2 />
            </CallControlButton>
            {isDeviceMenuOpen ? (
              <CallDeviceMenu controller={controller} includesCamera={isVideoCall} />
            ) : null}
          </div>
          {isMeeting && call.createdByAccountId === controller.account?.accountId ? (
            <CallControlButton
              label="Notify"
              ariaLabel="Notify participants again"
              onClick={() => { void controller.invite(); }}
            >
              <Users />
            </CallControlButton>
          ) : null}
          <CallControlButton
            label={canEndForEveryone ? 'End' : 'Leave'}
            ariaLabel={canEndForEveryone ? 'End call' : 'Leave call'}
            tone="danger"
            onClick={() => { void (canEndForEveryone ? controller.end() : controller.leave()); }}
          >
            <PhoneOff />
          </CallControlButton>
        </footer>
      </section>
    </div>
  );
}

function CallCard({
  controller,
  mode,
}: {
  controller: CloudCallsController;
  mode: 'incoming' | 'handoff';
}) {
  const presented = mode === 'incoming' ? controller.incomingCall : controller.handoffCall;
  if (!presented) return null;
  const participant = otherParticipant(presented.call, controller.account?.accountId);
  const title = presented.call.kind === 'meeting' ? 'Group meeting' : participantName(participant);
  return (
    <aside className="app-call-card" aria-label={mode === 'incoming' ? `Incoming call from ${title}` : 'Call active on another device'}>
      <IdentityAvatar
        kind="human"
        seed={participant?.accountId || presented.call.id}
        name={title}
        imageUrl={participant?.avatarUrl}
        className="app-call-card-avatar"
      />
      <div
        className="app-call-card-copy"
        aria-live={mode === 'incoming' ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        <strong>{title}</strong>
        <span>{mode === 'incoming' ? `Incoming ${callKindLabel(presented.call)}` : 'Call active on another device'}</span>
      </div>
      <div className="app-call-card-actions">
        {mode === 'incoming' ? (
          <button
            type="button"
            className="app-call-card-button app-call-card-decline"
            onClick={() => { void controller.decline(presented.call, presented.sessionId); }}
            aria-label="Decline call"
            title="Decline"
          >
            <PhoneOff />
          </button>
        ) : null}
        <button
          type="button"
          className="app-call-card-button app-call-card-answer"
          onClick={() => { void controller.join(presented.call, presented.sessionId); }}
          aria-label={mode === 'incoming' ? 'Answer call' : 'Move call to this Mac'}
          title={mode === 'incoming' ? 'Answer' : 'Move to this Mac'}
        >
          {presented.call.kind === 'voice' ? <PhoneIncoming /> : <Video />}
        </button>
      </div>
    </aside>
  );
}

function CallError({ controller }: { controller: CloudCallsController }) {
  if (!controller.error || controller.currentCall) return null;
  const recovery = recoveryContent(controller.error, controller.phase);
  return (
    <div className="app-call-error" role="alert">
      <RefreshCw aria-hidden="true" />
      <span><strong>{recovery.title}</strong>{recovery.description}</span>
      <button type="button" onClick={() => controller.dismissError()} aria-label="Dismiss call error">
        <X />
      </button>
    </div>
  );
}

export function CloudCallHost({ controller }: { controller: CloudCallsController }) {
  const activeSurface = controller.currentCall && controller.isPresented;
  const cardMode = controller.incomingCall
    ? 'incoming' as const
    : controller.handoffCall
      ? 'handoff' as const
      : null;
  return (
    <>
      {controller.currentCall ? controller.mediaParticipants.map((participant) => (
        !participant.isLocal && participant.audioTrack
          ? <AttachedAudio key={`audio:${participant.accountId}`} track={participant.audioTrack} />
          : null
      )) : null}
      {activeSurface ? <CallSurface controller={controller} /> : null}
      {cardMode ? <CallCard controller={controller} mode={cardMode} /> : null}
      <CallError controller={controller} />
    </>
  );
}

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Camera,
  CameraOff,
  Mic,
  MicOff,
  Minimize2,
  PhoneIncoming,
  PhoneOff,
  Users,
  Video,
  Volume2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  AppDialog,
  AppDialogActions,
  AppDialogDescription,
  AppDialogTitle,
} from '@/components/ui/dialog';
import { ErrorLine, type ErrorLineAction } from '@/components/ui/ErrorLine';

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
import { callPermissionCopy } from './callMediaPermission';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { MediaPermissionDialog } from './MediaPermissionDialog';

type CallSurfaceNotice = {
  text: string;
  action: ErrorLineAction;
};

/**
 * The one error line on an open call: a failed call offers to rejoin,
 * paused audio offers to start it, and anything else can be dismissed.
 */
function callSurfaceNotice(
  controller: CloudCallsController,
  rejoin: () => void,
): CallSurfaceNotice | null {
  const recovery = controller.error ? recoveryContent(controller.error, controller.phase) : null;
  if (recovery && controller.phase === 'failed') {
    return { text: recovery.line, action: { label: 'Try again', onClick: rejoin } };
  }
  if (controller.isAudioPlaybackBlocked) {
    return {
      text: 'Audio is paused.',
      action: { label: 'Start audio', onClick: () => { void controller.resumeAudio(); } },
    };
  }
  if (recovery) {
    return { text: recovery.line, action: { label: 'Dismiss', onClick: () => controller.dismissError() } };
  }
  return null;
}

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
  const notice = callSurfaceNotice(controller, () => { void controller.join(call, current.sessionId); });
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
        <p className="sr-only" role="status" aria-live="polite">{status}</p>
        <header className="app-call-surface-header">
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
                status={controller.phase === 'failed' ? 'Keeping the call open…' : status}
              />
            )}
            {isVideoCall && localParticipant ? (
              <CallParticipantTile participant={localParticipant} className="app-call-local-preview" />
            ) : null}
          </div>
        )}

        {notice ? (
          <ErrorLine className="app-call-notice" align="center" action={notice.action}>
            {notice.text}
          </ErrorLine>
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
  mode: 'incoming' | 'detached';
}) {
  const presented = mode === 'incoming'
    ? controller.incomingCall
    : controller.detachedCall;
  if (!presented) return null;
  const participant = otherParticipant(presented.call, controller.account?.accountId);
  const title = presented.call.kind === 'meeting' ? 'Group meeting' : participantName(participant);
  if (mode === 'detached') {
    return (
      <aside className="app-call-card app-call-card-detached" aria-label="Call active in a separate window">
        <button
          type="button"
          className="app-call-detached-preview"
          onClick={() => { void controller.showWindow(); }}
          aria-label="Open call window"
          title="Open call window"
        >
          {controller.detachedThumbnailUrl ? (
            <img src={controller.detachedThumbnailUrl} alt="" />
          ) : (
            <IdentityAvatar
              kind="human"
              seed={participant?.accountId || presented.call.id}
              name={title}
              imageUrl={participant?.avatarUrl}
              className="app-call-detached-avatar"
            />
          )}
        </button>
      </aside>
    );
  }
  return (
    <aside
      className="app-call-card"
      aria-label={`Incoming call from ${title}`}
    >
      <IdentityAvatar
        kind="human"
        seed={participant?.accountId || presented.call.id}
        name={title}
        imageUrl={participant?.avatarUrl}
        className="app-call-card-avatar"
      />
      <div
        className="app-call-card-copy"
        aria-live="assertive"
        aria-atomic="true"
      >
        <strong>{title}</strong>
        <span>{`Incoming ${callKindLabel(presented.call)}`}</span>
      </div>
      <div className="app-call-card-actions">
        <button
          type="button"
          className="app-call-card-button app-call-card-decline"
          onClick={() => { void controller.decline(presented.call, presented.sessionId); }}
          aria-label="Decline call"
          title="Decline"
        >
          <PhoneOff />
        </button>
        <button
          type="button"
          className="app-call-card-button app-call-card-answer"
          onClick={() => {
            void controller.join(presented.call, presented.sessionId);
          }}
          aria-label="Answer call"
          title="Answer"
        >
          {presented.call.kind === 'voice' ? <PhoneIncoming /> : <Video />}
        </button>
      </div>
    </aside>
  );
}

/** A call that failed to start or join, with no call surface to show it on. */
function CallError({ controller }: { controller: CloudCallsController }) {
  if (!controller.error || controller.currentCall || controller.phase === 'idle') return null;
  const recovery = recoveryContent(controller.error, controller.phase);
  const dismiss = () => controller.dismissError();
  return (
    <AppDialog
      titleId="call-error-title"
      descriptionId="call-error-description"
      onDismiss={dismiss}
      className="max-w-sm rounded-[20px]"
    >
      <AppDialogTitle id="call-error-title">{recovery.title}</AppDialogTitle>
      <AppDialogDescription id="call-error-description">{recovery.description}</AppDialogDescription>
      <AppDialogActions>
        <Button className="rounded-full px-4" autoFocus onClick={dismiss}>OK</Button>
      </AppDialogActions>
    </AppDialog>
  );
}

function CallPermissionDialog({ controller }: { controller: CloudCallsController }) {
  const issue = controller.permissionIssue;
  if (!issue) return null;
  return (
    <MediaPermissionDialog
      issue={issue}
      copy={callPermissionCopy(issue)}
      onCancel={() => controller.dismissPermissionIssue()}
      onOpenSettings={() => { void controller.openPermissionSettings(); }}
    />
  );
}

export function CloudCallHost({
  controller,
  suppressCurrentSurface = false,
}: {
  controller: CloudCallsController;
  suppressCurrentSurface?: boolean;
}) {
  const activeSurface = controller.currentCall
    && controller.isPresented
    && !suppressCurrentSurface;
  const cardMode = controller.incomingCall
    ? 'incoming' as const
    : controller.detachedCall && controller.isDetachedCallFolded
      ? 'detached' as const
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
      <CallPermissionDialog controller={controller} />
    </>
  );
}

import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

import type {
  CloudCallMediaParticipant,
  CloudCallsController,
} from './cloudCallController';
import type { CloudCall, CloudCallParticipant } from './cloudCalls';

const CALL_FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type CallRecoveryContent = {
  /** Dialog title when no call surface is open. */
  title: string;
  /** The one dialog line under the title. */
  description: string;
  /** The single error line shown on an open call surface. */
  line: string;
};

export function useCallDuration(connectedAtMs: number | null): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!connectedAtMs) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [connectedAtMs]);
  if (!connectedAtMs) return null;
  const seconds = Math.max(0, Math.floor((nowMs - connectedAtMs) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function useCallDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
) {
  const escapeRef = useRef(onEscape);
  useEffect(() => {
    escapeRef.current = onEscape;
  }, [onEscape]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialog.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        escapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(CALL_FOCUSABLE_SELECTOR)]
        .filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [dialogRef]);
}

export function participantName(participant: CloudCallParticipant | undefined): string {
  return participant?.displayName?.trim() || 'Kordi user';
}

export function otherParticipant(call: CloudCall, accountId: string | undefined) {
  return call.participants.find((participant) => participant.accountId !== accountId)
    ?? call.participants[0];
}

export function callTitle(call: CloudCall, accountId: string | undefined): string {
  if (call.kind === 'meeting') return 'Group meeting';
  return participantName(otherParticipant(call, accountId));
}

export function callKindLabel(call: CloudCall): string {
  if (call.kind === 'voice') return 'voice call';
  if (call.kind === 'video') return 'video call';
  return 'group meeting';
}

export function phaseLabel(controller: CloudCallsController): string {
  if (controller.phase === 'preparing') return 'Checking microphone and camera…';
  if (controller.phase === 'connecting') return 'Connecting…';
  if (controller.phase === 'ringing') return 'Ringing…';
  if (controller.phase === 'reconnecting') return 'Reconnecting…';
  if (controller.phase === 'failed') return 'Disconnected';
  return controller.connectedAtMs ? 'Connected' : 'Starting call…';
}

export function recoveryContent(
  error: string,
  phase: CloudCallsController['phase'],
): CallRecoveryContent {
  const normalized = error.toLowerCase();
  // Checked before the permission wording, which this message also mentions.
  const switchFailure = /could not switch the (microphone|camera|speaker)/.exec(normalized);
  if (switchFailure) {
    const device = switchFailure[1];
    return {
      title: `Couldn't switch the ${device}`,
      description: 'Choose another device or check its access in System Settings.',
      line: `Couldn't switch the ${device}.`,
    };
  }
  if (normalized.includes('could not read the media devices')) {
    return {
      title: "Couldn't read call devices",
      description: 'Check System Settings, then try again.',
      line: "Couldn't read call devices.",
    };
  }
  if (normalized.includes('speaker selection')) {
    return {
      title: 'Speaker follows macOS',
      description: 'Choose the speaker in macOS Sound settings.',
      line: 'Choose the speaker in macOS Sound settings.',
    };
  }
  if (normalized.includes('start audio')) {
    return {
      title: 'Audio is paused',
      description: 'Select Start audio to hear the others.',
      line: 'Audio is paused.',
    };
  }
  // Refused devices normally open the permission dialog; this is a fallback.
  if (normalized.includes('permission')
    || normalized.includes('notallowed')
    || normalized.includes('denied')) {
    return {
      title: 'Microphone or camera unavailable',
      description: 'Allow Kordi access in System Settings, then try again.',
      line: 'Microphone or camera access is off.',
    };
  }
  if (normalized.includes('could not find') || normalized.includes('notfound')) {
    return {
      title: 'Microphone or camera unavailable',
      description: 'Connect a microphone or camera, then try again.',
      line: "Couldn't find a microphone or camera.",
    };
  }
  if (normalized.includes('publication') || normalized.includes('subscribed')) {
    return {
      title: 'Call media unavailable',
      description: 'Some audio or video could not connect.',
      line: 'Some audio or video could not connect.',
    };
  }
  if (phase === 'failed'
    || normalized.includes('connection')
    || normalized.includes('transport')
    || normalized.includes('websocket')
    || normalized.includes('signal')
    || normalized.includes('pc ')) {
    return {
      title: 'Connection lost',
      description: 'Check your network, then try again.',
      line: 'Connection lost. Your call is still open.',
    };
  }
  return {
    title: 'Call needs attention',
    description: 'Kordi could not finish that. Try again in a moment.',
    line: 'Kordi could not finish that.',
  };
}

export function callParticipants(
  call: CloudCall,
  mediaParticipants: CloudCallMediaParticipant[],
  accountId: string | undefined,
): CloudCallMediaParticipant[] {
  const liveParticipantIds = new Set(mediaParticipants.map((participant) => participant.accountId));
  const fallbackParticipants = call.participants.flatMap((participant) => {
    if (participant.state !== 'joined' || liveParticipantIds.has(participant.accountId)) return [];
    return [{
      accountId: participant.accountId,
      name: participantName(participant),
      avatarUrl: participant.avatarUrl,
      isLocal: participant.accountId === accountId,
      isSpeaking: false,
      microphoneEnabled: true,
      cameraEnabled: false,
      audioTrack: null,
      videoTrack: null,
    }];
  });
  return [...mediaParticipants, ...fallbackParticipants];
}

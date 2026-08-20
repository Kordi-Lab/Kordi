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
  title: string;
  description: string;
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
  if (normalized.includes('permission')
    || normalized.includes('notallowed')
    || normalized.includes('denied')) {
    return {
      title: 'Microphone or camera unavailable',
      description: 'Allow Kordi access in macOS System Settings, then try again.',
    };
  }
  if (normalized.includes('system settings') || normalized.includes('switch the')) {
    return {
      title: 'Check your call devices',
      description: error,
    };
  }
  if (normalized.includes('could not find') || normalized.includes('notfound')) {
    return {
      title: 'Microphone or camera unavailable',
      description: error,
    };
  }
  if (normalized.includes('publication') || normalized.includes('subscribed')) {
    return {
      title: 'Call media unavailable',
      description: error,
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
      description: 'Your call is still open. Check your network, then try again.',
    };
  }
  return {
    title: 'Call needs attention',
    description: 'Kordi could not continue this action. Try again or choose another device.',
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

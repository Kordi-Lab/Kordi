import { useEffect, useState } from 'react';
import { ArrowUpRight, Phone, Users, Video } from 'lucide-react';

import { useCloudCallContext } from './useCloudCallContext';
import type { CloudCallPhase } from './cloudCallController';
import type { Conversation } from '@/kordi-app/types';

function useCallDuration(connectedAtMs: number | null): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!connectedAtMs) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [connectedAtMs]);
  if (!connectedAtMs) return null;
  const seconds = Math.max(0, Math.floor((nowMs - connectedAtMs) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function currentPhaseLabel(phase: CloudCallPhase): string {
  if (phase === 'preparing') return 'Preparing';
  if (phase === 'connecting') return 'Connecting';
  if (phase === 'ringing') return 'Ringing';
  if (phase === 'reconnecting') return 'Reconnecting';
  if (phase === 'failed') return 'Disconnected';
  return 'Connected';
}

export function ConversationCallBanner({ conversation }: { conversation: Conversation }) {
  const calls = useCloudCallContext();
  const current = calls?.currentCall ?? null;
  const conversationCall = calls?.callForConversation(conversation) ?? null;
  const call = current?.call ?? conversationCall;
  const duration = useCallDuration(current ? calls?.connectedAtMs ?? null : null);
  if (!calls || !call || call.state === 'ended') return null;

  const hostOwnsCall = (current?.call.id === call.id && calls.isPresented)
    || calls.incomingCall?.call.id === call.id
    || calls.handoffCall?.call.id === call.id
    || calls.detachedCall?.call.id === call.id;
  if (hostOwnsCall) return null;

  const isCurrent = current?.call.id === call.id;
  const target = calls.targetForConversation(conversation);
  const joinedCount = call.participants.filter((participant) => participant.state === 'joined').length;
  const otherParticipant = call.participants.find(
    (participant) => participant.accountId !== calls.account?.accountId,
  );
  const title = call.kind === 'meeting'
    ? 'Group call'
    : otherParticipant?.displayName?.trim() || (current ? 'Current call' : conversation.name);
  const kindLabel = call.kind === 'voice' ? 'Voice call' : call.kind === 'video' ? 'Video call' : 'Video chat';
  const status = isCurrent
    ? duration || currentPhaseLabel(calls.phase)
    : call.state === 'ringing'
      ? 'Ringing'
      : call.kind === 'meeting'
        ? `${joinedCount} ${joinedCount === 1 ? 'person' : 'people'} in the call`
        : 'Active on another device';
  const selfParticipant = call.participants.find(
    (participant) => participant.accountId === calls.account?.accountId,
  );
  const isHandoff = !isCurrent && (
    call.createdByAccountId === calls.account?.accountId
    || selfParticipant?.state === 'joined'
  );
  const actionLabel = isCurrent ? 'Return' : isHandoff ? 'Move here' : 'Join';

  return (
    <div className="app-conversation-call-banner" aria-label="Current call">
      <span className="app-conversation-call-banner-icon" data-phase={isCurrent ? calls.phase : call.state} aria-hidden="true">
        {call.kind === 'voice' ? <Phone /> : call.kind === 'meeting' ? <Users /> : <Video />}
        <i />
      </span>
      <div
        className="app-conversation-call-banner-copy"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <strong>{title}</strong>
        <span><b>{kindLabel}</b><i aria-hidden="true">·</i>{status}</span>
      </div>
      <button
        type="button"
        onClick={() => {
          if (isCurrent) calls.show();
          else void calls.join(call, target?.sessionId);
        }}
      >
        <span>{actionLabel}</span>
        <ArrowUpRight aria-hidden="true" />
      </button>
    </div>
  );
}

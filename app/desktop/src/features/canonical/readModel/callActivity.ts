import type { CanonicalSessionMessage } from '@/kordi-app/types';
import type { MessageCallActivity } from '@/kordi-app/types/message';

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function canonicalCallActivityIdentity(messageKind: string): {
  callId: string;
  event: MessageCallActivity['event'];
} | null {
  const match = /^call\.(started|ended)\.(.+)$/.exec(messageKind.trim());
  if (!match?.[2]) return null;
  return {
    callId: match[2],
    event: match[1] as MessageCallActivity['event'],
  };
}

function legacyCallActivityKind(text: string): MessageCallActivity['kind'] {
  const normalized = text.toLowerCase();
  if (normalized.includes('video chat')) return 'meeting';
  if (normalized.includes('video call')) return 'video';
  return 'voice';
}

function legacyCallActivityDurationSeconds(text: string): number | null {
  const match = /\bduration\s+(?:(\d+):)?(\d+):(\d+)\b/i.exec(text);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return Math.max(0, Math.floor(hours * 3_600 + minutes * 60 + seconds));
}

export function canonicalCallActivity(
  message: CanonicalSessionMessage,
  content: Record<string, unknown>,
  isOwnMessage: boolean,
): MessageCallActivity | undefined {
  const identity = canonicalCallActivityIdentity(message.messageKind);
  if (!identity) return undefined;
  const activity = recordValue(content.callActivity);
  const structured = activity.schema === 1;
  const rawKind = stringValue(activity.kind);
  const kind = rawKind === 'voice' || rawKind === 'video' || rawKind === 'meeting'
    ? rawKind
    : legacyCallActivityKind(message.contentText);
  const rawDuration = numberValue(activity.durationSeconds);
  const durationSeconds = rawDuration === undefined
    ? legacyCallActivityDurationSeconds(message.contentText)
    : Math.max(0, Math.floor(rawDuration));
  const answered = structured
    ? numberValue(activity.answeredAtMs) !== undefined || rawDuration !== undefined
    : durationSeconds !== null && durationSeconds > 0;
  const direction = isOwnMessage ? 'outgoing' : 'incoming';
  const outcome: MessageCallActivity['outcome'] = identity.event === 'started'
    ? 'ringing'
    : answered
      ? 'completed'
      : structured || durationSeconds !== null
        ? direction === 'outgoing' ? 'canceled' : 'missed'
        : 'ended';
  return {
    callId: identity.callId,
    kind,
    event: identity.event,
    direction,
    outcome,
    durationSeconds,
  };
}

export function completedCallStartMessageIds(
  messages: readonly Pick<CanonicalSessionMessage, 'id' | 'messageKind'>[],
): Set<string> {
  const endedCallIds = new Set(
    messages.flatMap((message) => {
      const activity = canonicalCallActivityIdentity(message.messageKind);
      return activity?.event === 'ended' ? [activity.callId] : [];
    }),
  );
  return new Set(
    messages.flatMap((message) => {
      const activity = canonicalCallActivityIdentity(message.messageKind);
      return activity?.event === 'started' && endedCallIds.has(activity.callId)
        ? [message.id]
        : [];
    }),
  );
}

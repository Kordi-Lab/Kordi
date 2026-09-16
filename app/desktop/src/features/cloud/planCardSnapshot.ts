import type { MessagePlanCard, MessagePlanCardParticipant } from '@/kordi-app/types/message';

const PLAN_CARD_STATES = new Set(['polling', 'awaiting_confirmation', 'confirmed', 'canceled']);

/**
 * Reads a plan card snapshot as the server writes it into a `plan_card`
 * message block, tolerating anything unexpected: the card is dropped, the
 * message is not.
 */
export function normalizePlanCardSnapshot(value: unknown): MessagePlanCard | null {
  if (!value || typeof value !== 'object') return null;
  const block = value as Record<string, unknown>;
  const eventId = typeof block.eventId === 'string' ? block.eventId : '';
  const title = typeof block.title === 'string' ? block.title : '';
  const state = typeof block.state === 'string' && PLAN_CARD_STATES.has(block.state) ? block.state : null;
  const revision = typeof block.revision === 'number' ? block.revision : null;
  if (!eventId || !title || !state || revision === null) return null;
  const participants = Array.isArray(block.participants)
    ? block.participants.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const participant = entry as Record<string, unknown>;
      const participantId = typeof participant.participantId === 'string' ? participant.participantId : '';
      if (!participantId) return [];
      const rsvp: MessagePlanCardParticipant['rsvp'] = participant.rsvp === 'yes' || participant.rsvp === 'no' ? participant.rsvp : 'pending';
      return [{
        participantId,
        displayName: typeof participant.displayName === 'string' && participant.displayName.trim() ? participant.displayName : 'Member',
        organizer: participant.organizer === true,
        rsvp,
      }];
    })
    : [];
  return {
    eventId,
    revision,
    state: state as MessagePlanCard['state'],
    title,
    startAt: typeof block.startAt === 'string' ? block.startAt : null,
    endAt: typeof block.endAt === 'string' ? block.endAt : null,
    location: typeof block.location === 'string' ? block.location : null,
    unresolvedFields: Array.isArray(block.unresolvedFields)
      ? block.unresolvedFields.filter((field): field is string => typeof field === 'string')
      : [],
    participants,
  };
}

/**
 * The newest snapshot of every card in a transcript, by event. Pip reposts the
 * card whenever it changes, so older messages carry stale copies; rendering
 * each of them with the newest state keeps every button at the current
 * revision.
 */
export function latestPlanCardsByEvent(
  messages: readonly { planCard?: MessagePlanCard | null }[],
): Map<string, MessagePlanCard> {
  const latest = new Map<string, MessagePlanCard>();
  for (const message of messages) {
    const card = message.planCard;
    if (!card) continue;
    const known = latest.get(card.eventId);
    if (!known || known.revision < card.revision) latest.set(card.eventId, card);
  }
  return latest;
}

/** Returns the same message when its card is already the newest snapshot. */
export function withLatestPlanCard<T extends { planCard?: MessagePlanCard | null }>(
  message: T,
  latest: Map<string, MessagePlanCard>,
): T {
  const card = message.planCard;
  if (!card) return message;
  const newest = latest.get(card.eventId);
  if (!newest || newest.revision <= card.revision) return message;
  return { ...message, planCard: newest };
}

import type { MessagePlanCard, MessagePlanCardOption, MessagePlanCardParticipant } from '@/kordi-app/types/message';

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
  const options: MessagePlanCardOption[] = Array.isArray(block.options)
    ? block.options.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const option = entry as Record<string, unknown>;
      const id = typeof option.id === 'string' ? option.id : '';
      const label = typeof option.label === 'string' ? option.label : '';
      if (!id || !label) return [];
      return [{
        id,
        label,
        startAt: typeof option.startAt === 'string' ? option.startAt : null,
        endAt: typeof option.endAt === 'string' ? option.endAt : null,
        location: typeof option.location === 'string' ? option.location : null,
        votes: Array.isArray(option.votes) ? option.votes.filter((voter): voter is string => typeof voter === 'string') : [],
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
    options,
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

/**
 * One card per plan in a transcript. Every message that carries a card keeps
 * only its text, except the newest one, which renders the newest snapshot so
 * the card sits next to the latest activity and its buttons act at the
 * current revision. Messages without a card come back unchanged.
 */
export function resolveTranscriptPlanCards<T extends { id?: string; planCard?: MessagePlanCard | null }>(
  messages: readonly T[],
): T[] {
  const latest = latestPlanCardsByEvent(messages);
  if (latest.size === 0) return [...messages];
  // The newest message carrying each card, by position in the transcript.
  const holder = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.planCard) holder.set(message.planCard.eventId, index);
  });
  return messages.map((message, index) => {
    const card = message.planCard;
    if (!card) return message;
    if (holder.get(card.eventId) !== index) return { ...message, planCard: null };
    const newest = latest.get(card.eventId);
    return !newest || newest.revision <= card.revision ? message : { ...message, planCard: newest };
  });
}

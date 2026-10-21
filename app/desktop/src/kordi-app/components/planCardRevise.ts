import type { EventTimeDraft } from '@/features/commonGround/EventTimeDialog';
import type { CgMeetInput } from '@/features/commonGround/types';
import type { PlanCardReviseRequest } from '@/features/cloud/planCardClient';
import type { MessagePlanCard } from '@/kordi-app/types/message';

const pad = (value: number) => String(value).padStart(2, '0');

/** The card's title, local start, length and place as the editor's opening values. */
export function planCardDraft(card: MessagePlanCard): Partial<EventTimeDraft> {
  const draft: Partial<EventTimeDraft> = { title: card.title, location: card.location ?? '' };
  const start = card.startAt ? new Date(card.startAt) : null;
  if (!start || Number.isNaN(start.getTime())) return draft;
  draft.date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  draft.time = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const end = card.endAt ? new Date(card.endAt) : null;
  const minutes = end ? Math.round((end.getTime() - start.getTime()) / 60_000) : NaN;
  if (Number.isFinite(minutes) && minutes > 0) draft.minutes = minutes;
  return draft;
}

/** Revises the card in place: the same people, the new time and place. */
export function planCardReviseRequest(card: MessagePlanCard, conversationId: string, input: CgMeetInput): PlanCardReviseRequest {
  return {
    action: 'propose',
    conversationId,
    existingEventId: card.eventId,
    existingRevision: card.revision,
    title: input.title?.trim() || card.title,
    startAt: input.startAt,
    ...(input.endAt ? { endAt: input.endAt } : {}),
    ...(input.location ? { location: input.location } : {}),
    state: card.state === 'polling' ? 'polling' : 'awaitingConfirmation',
    unresolvedFields: [],
    participants: card.participants.map((participant) => ({
      participantId: participant.participantId,
      displayName: participant.displayName,
      organizer: participant.organizer,
    })),
  };
}

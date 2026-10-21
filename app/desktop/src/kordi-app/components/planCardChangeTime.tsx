import { EventTimeDialog } from '@/features/commonGround/EventTimeDialog';
import type { CgMeetInput } from '@/features/commonGround/types';
import type { MessagePlanCard } from '@/kordi-app/types/message';
import { planCardDraft } from './planCardRevise';

/** The Meet editor, opened from the organizer's card with its current details. */
export function PlanCardChangeTimeDialog({ card, accountId, busy, onCancel, onSubmit }: {
  card: MessagePlanCard;
  accountId: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: CgMeetInput) => void;
}) {
  const people = card.participants
    .map((participant) => ({ accountId: participant.participantId, name: participant.displayName, avatarUrl: participant.avatarUrl ?? null, isSelf: participant.participantId === accountId }))
    .sort((left, right) => Number(right.isSelf) - Number(left.isSelf));
  return (
    <EventTimeDialog
      heading="Change time"
      submitLabel="Save"
      initial={planCardDraft(card)}
      fallbackTitle={card.title}
      people={people}
      busy={busy}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

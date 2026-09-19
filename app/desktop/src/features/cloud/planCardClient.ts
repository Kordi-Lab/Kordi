import type { MessagePlanCard } from '@/kordi-app/types/message';
import { CloudAuthError, defaultCloudAuthClient } from './authClient';

export type PlanCardActionRequest =
  | { action: 'rsvp'; eventId: string; participantId: string; rsvp: 'yes' | 'no'; note?: string }
  | { action: 'vote'; eventId: string; participantId: string; optionId: string }
  | { action: 'confirm'; eventId: string; revision: number; confirmedBy: string; optionId?: string }
  | { action: 'cancel'; eventId: string; revision: number; canceledBy: string; reason?: string };

/** Acts on a shared plan card as the signed-in member. */
export async function planCardAction(token: string, request: PlanCardActionRequest): Promise<MessagePlanCard> {
  let response: MessagePlanCard;
  try {
    response = await defaultCloudAuthClient().request<MessagePlanCard>(
      '/v1/cloud/plan_cards',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(request),
      },
      'Could not update the plan card.',
    );
  } catch (error) {
    if (!(error instanceof CloudAuthError) || error.code !== 'plan_card_revision_conflict') throw error;
    // Refresh only. Confirming changed details requires another deliberate click.
    response = await defaultCloudAuthClient().request<MessagePlanCard>(
      `/v1/cloud/plan_cards/${encodeURIComponent(request.eventId)}`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      'Could not refresh the plan card. Try again.',
    );
  }
  if (!response) throw new Error('Empty response from cloud server.');
  return { ...response, unresolvedFields: response.unresolvedFields ?? [], participants: response.participants ?? [] };
}

import { ProactiveOfferCard } from '@/kordi-app/components/proactiveOfferCard';
import type { Conversation } from '@/kordi-app/types';
import { proactiveConversationKey, useProactiveProposals } from './useProactiveProposals';

/**
 * Offers from the signed-in owner's agents to help in the open conversation.
 * Sits above the composer, next to connector approvals. Other members never
 * see it: the server returns only the caller's own agents' proposals.
 */
export function ProactiveOfferPrompt({
  conversation,
  accountId,
  now,
}: {
  conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'messages'>;
  accountId: string | null | undefined;
  now?: number;
}) {
  const { proposals, decide } = useProactiveProposals(proactiveConversationKey(conversation, accountId), now);
  if (proposals.length === 0) return null;
  return (
    <div className="app-proactive-offer-prompt" data-proactive-offer-prompt="true">
      {proposals.map((proposal) => (
        <ProactiveOfferCard key={proposal.proposalId} proposal={proposal} decide={decide} now={now} />
      ))}
    </div>
  );
}

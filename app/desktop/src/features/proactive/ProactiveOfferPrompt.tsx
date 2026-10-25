import { ProactiveOfferCard } from '@/kordi-app/components/proactiveOfferCard';
import { proactiveConversationKey, useProactiveProposals, type ProactiveConversation } from './useProactiveProposals';

/**
 * Offers from the signed-in owner's agents to help in the open conversation.
 * Sits above the composer, next to connector approvals. Other members never
 * see it: the server returns only the caller's own agents' proposals. Only
 * cloud groups ask for offers; one-to-one chats never send the request.
 */
export function ProactiveOfferPrompt({
  conversation,
  accountId,
  now,
}: {
  conversation: ProactiveConversation;
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

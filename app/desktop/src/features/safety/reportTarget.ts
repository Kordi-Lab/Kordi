import { KORDI_SYSTEM_NOTICE_KIND } from '@/features/systemAgent/systemAgentIdentity';
import { transcriptMessageIsOwnHuman } from '@/kordi-app/components/transcriptMessageHumanRole';
import type { Message } from '@/kordi-app/types';

import { isCloudUuid } from './safetyClient';
import type { ReportTarget } from './safetyTypes';
import { humanIdentityAccountId, isServiceAccountId, isServiceIdentityId } from './serviceAccounts';

/**
 * A report about one finished hosted message someone else wrote, or null when
 * the message cannot be reported. Agent messages name the agent's owner; the
 * server resolves the account from the message.
 */
export function reportTargetForMessage(message: Message): ReportTarget | null {
  if (message.role === 'system' || message.role === 'action' || message.role === 'edit') return null;
  if (message.role === 'owned-agent' || transcriptMessageIsOwnHuman(message)) return null;
  if (message.turn && !message.turn.completed) return null;
  if (message.supportContactResponse || message.supportContactTyping) return null;
  if (message.messageKind === KORDI_SYSTEM_NOTICE_KIND || isServiceIdentityId(message.senderIdentityId)) return null;
  const conversationId = message.reactionConversationId?.trim();
  const messageId = message.reactionTargetMessageId?.trim();
  if (!conversationId || !messageId || !isCloudUuid(messageId)) return null;
  const isAgent = message.senderType === 'agent';
  const accountId = isAgent ? null : humanIdentityAccountId(message.senderIdentityId);
  if (isServiceAccountId(accountId)) return null;
  const name = (isAgent ? message.senderOwnerName?.trim() : '') || message.sender?.trim() || 'this person';
  return { accountId, name, conversationId, messageIds: [messageId] };
}

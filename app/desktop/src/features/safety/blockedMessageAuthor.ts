// Which messages come from an account the viewer blocked. Group chats keep
// those messages in the shared history, so the transcript collapses them and
// message alerts skip them.

import { transcriptMessageIsOwnHuman } from '@/kordi-app/components/transcriptMessageHumanRole';
import type { Message } from '@/kordi-app/types';

import { humanIdentityAccountId } from './serviceAccounts';

const CLOUD_AGENT_PREFIX = 'agent:cloud:';
const DEFAULT_AGENT_PREFIX = 'cloud-agent:';

/**
 * The account behind a message: the human sender, or the owner of a hosted
 * agent when the sender identity names it (`agent:cloud:<account>` or the
 * owner's default agent `agent:cloud:cloud-agent:<account>`). Null otherwise.
 */
export function messageAuthorAccountId(message: Pick<Message, 'senderIdentityId' | 'senderType'>): string | null {
  const identityId = message.senderIdentityId?.trim() ?? '';
  if (!identityId) return null;
  if (identityId.startsWith(CLOUD_AGENT_PREFIX)) {
    let agentId = identityId.slice(CLOUD_AGENT_PREFIX.length).trim();
    if (agentId.startsWith(DEFAULT_AGENT_PREFIX)) agentId = agentId.slice(DEFAULT_AGENT_PREFIX.length).trim();
    return agentId.startsWith('acct_') ? agentId : null;
  }
  if (message.senderType === 'agent' || identityId.startsWith('agent:')) return null;
  return humanIdentityAccountId(identityId);
}

/** Whether someone else's message was written by, or for, a blocked account. */
export function isMessageFromBlockedAccount(message: Message, blockedAccountIds: ReadonlySet<string>): boolean {
  if (blockedAccountIds.size === 0) return false;
  if (message.role === 'system' || message.role === 'action' || message.role === 'edit') return false;
  if (message.role === 'owned-agent' || message.isOwnMessage === true || transcriptMessageIsOwnHuman(message)) return false;
  const accountId = messageAuthorAccountId(message);
  return Boolean(accountId && blockedAccountIds.has(accountId));
}

/** The key a revealed message is remembered by for the rest of the app session. */
export function blockedMessageRevealKey(message: Pick<Message, 'id' | 'entryId'>): string {
  return message.id?.trim() || message.entryId?.trim() || '';
}

/** Whether a group-chat row shows the collapsed blocked-account row instead of the message. */
export function shouldCollapseBlockedMessage({
  message,
  groupConversation,
  blockedAccountIds,
  revealedKeys,
}: {
  message: Message;
  groupConversation: boolean;
  blockedAccountIds: ReadonlySet<string>;
  revealedKeys: ReadonlySet<string>;
}): boolean {
  if (!groupConversation || !isMessageFromBlockedAccount(message, blockedAccountIds)) return false;
  const key = blockedMessageRevealKey(message);
  return !key || !revealedKeys.has(key);
}

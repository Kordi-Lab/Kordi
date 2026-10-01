// Whether a person-to-person chat can send, from the contact and block
// lists. The server enforces the rule; this only explains it, so nothing is
// shown unless both lists loaded successfully.

import { cloudSessionIdFromConversationId } from '@/features/collaboration/conversationIds';
import type { Contact, ContactRequest } from '@/kordi-app/types';

import type { CloudBlockedAccount } from './safetyTypes';
import { isServiceAccountId } from './serviceAccounts';

const DIRECT_PERSON_PREFIX = 'session:direct-person:';

export type DirectConsentKind = 'contact' | 'blocked' | 'incoming' | 'outgoing' | 'none';

export type DirectConsentState = {
  peerAccountId: string;
  kind: DirectConsentKind;
  requestId: string | null;
};

/** The other person's account in a `session:direct-person:` chat. */
export function directPersonPeerAccountId(
  conversation: { id: string; canonicalSessionId?: string | null },
  selfAccountId: string | null | undefined,
): string | null {
  const self = selfAccountId?.trim();
  if (!self) return null;
  const sessionId = conversation.canonicalSessionId?.trim()
    || cloudSessionIdFromConversationId(conversation.id)
    || conversation.id.trim();
  if (!sessionId.startsWith(DIRECT_PERSON_PREFIX)) return null;
  const accounts = sessionId.slice(DIRECT_PERSON_PREFIX.length).split(':').map((value) => value.trim());
  if (accounts.length !== 2 || !accounts.includes(self)) return null;
  const peer = accounts.find((value) => value !== self) ?? '';
  return peer.startsWith('acct_') && !isServiceAccountId(peer) ? peer : null;
}

export type DirectConsentInputs = {
  peerAccountId: string | null;
  contacts: {
    contacts: readonly Contact[];
    requests: readonly ContactRequest[];
    initialLoadSettled: boolean;
    loading: boolean;
    error: string | null;
  };
  blocks: {
    blocks: readonly CloudBlockedAccount[];
    loaded: boolean;
    available: boolean;
    error: string | null;
  };
};

function pending(request: ContactRequest, direction: 'incoming' | 'outgoing'): boolean {
  return (request.status?.trim().toLowerCase() || 'pending') === 'pending'
    && request.direction?.trim().toLowerCase() === direction;
}

export function directConversationConsentState({ peerAccountId, contacts, blocks }: DirectConsentInputs): DirectConsentState | null {
  if (!peerAccountId) return null;
  if (!contacts.initialLoadSettled || contacts.loading || contacts.error) return null;
  if (!blocks.loaded || !blocks.available || blocks.error) return null;
  if (blocks.blocks.some((block) => block.accountId === peerAccountId)) {
    return { peerAccountId, kind: 'blocked', requestId: null };
  }
  const isContact = contacts.contacts.some((contact) => (
    !contact.systemContact && (contact.sourceParticipantId === peerAccountId || contact.sourceHumanId === peerAccountId)
  ));
  if (isContact) return { peerAccountId, kind: 'contact', requestId: null };
  const incoming = contacts.requests.find((request) => pending(request, 'incoming') && request.requesterNodeId === peerAccountId);
  if (incoming) return { peerAccountId, kind: 'incoming', requestId: incoming.sourceRequestId ?? null };
  const outgoing = contacts.requests.find((request) => pending(request, 'outgoing') && request.targetNodeId === peerAccountId);
  if (outgoing) return { peerAccountId, kind: 'outgoing', requestId: outgoing.sourceRequestId ?? null };
  return { peerAccountId, kind: 'none', requestId: null };
}

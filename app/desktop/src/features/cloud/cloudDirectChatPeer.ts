import type { Contact, Conversation, ConversationParticipant } from '@/kordi-app/types';
import { cloudConversationKindFromConversationId, cloudPeerAccountIdFromConversationId } from '@/features/collaboration/conversationIds';

const DIRECT_PERSON_SESSION_PREFIX = 'session:direct-person:';

/** The other account of a hosted one-to-one person chat, or null for any other conversation. */
export function cloudDirectChatPeerAccountId(conversation: Pick<Conversation, 'id' | 'type' | 'canonicalSessionId'>, selfAccountId: string): string | null {
  if (conversation.type !== 'person') return null;
  const self = selfAccountId.trim();
  const fromId = cloudConversationKindFromConversationId(conversation.id) === 'person'
    ? cloudPeerAccountIdFromConversationId(conversation.id)
    : null;
  if (fromId && fromId !== self) return fromId;
  const sessionId = conversation.canonicalSessionId?.trim() ?? '';
  if (!sessionId.startsWith(DIRECT_PERSON_SESSION_PREFIX)) return null;
  const others = sessionId.slice(DIRECT_PERSON_SESSION_PREFIX.length).split(':').filter((id) => id && id !== self);
  return others.length === 1 ? others[0] : null;
}

/** The chat's participant for the other account, as the chat header and transcript hand it to the profile popover. */
export function directChatPeerParticipant(conversation: Conversation, peerAccountId: string, peer: Contact): ConversationParticipant {
  const found = conversation.canonicalParticipants?.find((participant) => (
    participant.kind === 'human'
    && [participant.humanId, participant.sourceIdentityId, participant.id.replace(/^human:/, '')].some((value) => value?.trim() === peerAccountId)
  ));
  return found ?? {
    id: `human:${peerAccountId}`,
    humanId: peerAccountId,
    name: peer.name,
    kind: 'human',
    role: 'person',
    source: 'cloud',
    profileImageUrl: peer.profileImageUrl ?? null,
    presenceStatus: peer.presenceStatus ?? null,
  };
}

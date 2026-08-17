import type { Conversation, ConversationParticipant, Message } from '@/kordi-app/types';
import { conversationIsGroupChat } from '@/pages/chatsPage.model';

export function transcriptHumanParticipant(
  conversation: Conversation,
  message: Message,
): ConversationParticipant | null {
  if (message.isOwnMessage || message.senderType === 'agent') return null;
  const humanParticipants = (conversation.canonicalParticipants ?? [])
    .filter((participant) => participant.kind === 'human');
  const senderIdentityId = message.senderIdentityId?.trim();
  if (senderIdentityId) {
    const exact = humanParticipants.find((participant) => (
      participant.id === senderIdentityId
      || participant.humanId?.trim() === senderIdentityId
      || participant.sourceIdentityId?.trim() === senderIdentityId
    ));
    if (exact) return exact;
  }
  const senderName = message.sender?.trim().toLocaleLowerCase();
  const nameMatches = senderName
    ? humanParticipants.filter((participant) => (
        participant.name.trim().toLocaleLowerCase() === senderName
      ))
    : [];
  if (nameMatches.length === 1) return nameMatches[0];
  if (conversationIsGroupChat(conversation) || conversation.type !== 'person') return null;

  const remoteHumanId = conversation.identity?.remoteHumanId?.trim()
    || conversation.collaborationTarget?.humanId?.trim()
    || conversation.collaborationTarget?.nodeId?.trim();
  if (!remoteHumanId) return null;
  const remoteName = conversation.identity?.remoteHumanName?.trim()
    || conversation.collaborationTarget?.ownerName?.trim()
    || conversation.collaborationTarget?.displayName?.trim()
    || message.sender?.trim()
    || conversation.name.trim();
  if (!remoteName) return null;

  return {
    id: `human:${remoteHumanId}`,
    humanId: conversation.identity?.remoteHumanId?.trim()
      || conversation.collaborationTarget?.humanId?.trim()
      || remoteHumanId,
    sourceIdentityId: conversation.collaborationTarget?.nodeId?.trim()
      || remoteHumanId,
    sourceHostId: conversation.collaborationTarget?.hostId?.trim()
      || conversation.identity?.sourceHostId?.trim()
      || null,
    name: remoteName,
    kind: 'human',
    role: 'person',
    source: conversation.collaborationTarget?.hostId === 'cloud' ? 'cloud' : 'bridge',
    avatarKey: message.senderAvatarSeed?.trim()
      || conversation.avatarSeed?.trim()
      || remoteHumanId,
    profileImageUrl: message.senderProfileImageUrl
      ?? conversation.profileImageUrl
      ?? null,
  };
}

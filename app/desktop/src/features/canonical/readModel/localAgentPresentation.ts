import type { ConversationParticipant, Message } from '@/kordi-app/types';

const LEGACY_DEFAULT_AGENT_LABEL = /^(?:my\s+)?kordi$/iu;

function currentDefaultAgentLabel(value: string | undefined, localAgentDisplayName?: string | null) {
  const preferred = localAgentDisplayName?.trim();
  return preferred && (!value?.trim() || LEGACY_DEFAULT_AGENT_LABEL.test(value.trim())) ? preferred : value;
}

export function presentCanonicalParticipants(
  participants: ConversationParticipant[],
  profileHumanIdentityId: string | null | undefined,
  localAgentDisplayName?: string | null,
) {
  return participants.map((participant) => {
    const name = participant.kind === 'agent'
      && (participant.role === 'owned-agent' || participant.ownerIdentityId === profileHumanIdentityId)
      ? currentDefaultAgentLabel(participant.name, localAgentDisplayName)
      : participant.name;
    return name === participant.name ? participant : { ...participant, name: name ?? participant.name };
  });
}

export function presentLocalAgentMessages(messages: Message[], localAgentDisplayName?: string | null) {
  return messages.map((message) => {
    if (message.role !== 'owned-agent' && message.senderOwnerName?.trim().toLowerCase() !== 'you') return message;
    const sender = currentDefaultAgentLabel(message.sender, localAgentDisplayName);
    const senderOwnerName = message.senderOwnerName?.trim() || 'You';
    return sender === message.sender && senderOwnerName === message.senderOwnerName
      ? message
      : { ...message, sender, senderOwnerName };
  });
}

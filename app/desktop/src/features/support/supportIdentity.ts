export const KORDI_SUPPORT_ACCOUNT_ID = 'acct_kordi_support';
export const KORDI_SUPPORT_AGENT_ID = 'cloud_agent_kordi_support';
export const KORDI_SUPPORT_NAME = 'Kordi Support';
export const KORDI_SUPPORT_SUBTITLE = 'Ask questions or suggest improvements';
export const KORDI_SUPPORT_AVATAR_URL = '/kordi-support-avatar.svg';

type SupportConversationIdentity = {
  id?: string | null;
  canonicalSessionId?: string | null;
  supportTicketEnabled?: boolean;
  collaborationTarget?: {
    nodeId?: string | null;
    humanId?: string | null;
    agentId?: string | null;
  } | null;
  identity?: {
    remoteHumanId?: string | null;
    remoteHumanNodeId?: string | null;
    remoteAgentId?: string | null;
    remoteAgentNodeId?: string | null;
  } | null;
  canonicalParticipants?: Array<{
    id?: string | null;
    ownerIdentityId?: string | null;
    sourceIdentityId?: string | null;
    humanId?: string | null;
    agentId?: string | null;
  }> | null;
};

function isSupportIdentityId(value: string | null | undefined): boolean {
  return value === KORDI_SUPPORT_ACCOUNT_ID || value === KORDI_SUPPORT_AGENT_ID;
}

function supportIdentityAppearsInSessionId(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? '';
  if (!normalized) return false;
  try {
    const decoded = decodeURIComponent(normalized);
    return decoded.includes(KORDI_SUPPORT_ACCOUNT_ID) || decoded.includes(KORDI_SUPPORT_AGENT_ID);
  } catch {
    return normalized.includes(KORDI_SUPPORT_ACCOUNT_ID)
      || normalized.includes(KORDI_SUPPORT_AGENT_ID);
  }
}

/**
 * Recognize the built-in support conversation before every cloud field finishes hydrating.
 * Its server-owned route must never become user-configurable during that transition.
 */
export function isKordiSupportConversation(
  conversation: SupportConversationIdentity,
): boolean {
  if (conversation.supportTicketEnabled === true) return true;
  if (
    supportIdentityAppearsInSessionId(conversation.id)
    || supportIdentityAppearsInSessionId(conversation.canonicalSessionId)
  ) {
    return true;
  }

  const target = conversation.collaborationTarget;
  if (
    isSupportIdentityId(target?.nodeId)
    || isSupportIdentityId(target?.humanId)
    || isSupportIdentityId(target?.agentId)
  ) {
    return true;
  }

  const identity = conversation.identity;
  if (
    isSupportIdentityId(identity?.remoteHumanId)
    || isSupportIdentityId(identity?.remoteHumanNodeId)
    || isSupportIdentityId(identity?.remoteAgentId)
    || isSupportIdentityId(identity?.remoteAgentNodeId)
  ) {
    return true;
  }

  return Boolean(conversation.canonicalParticipants?.some((participant) => (
    supportIdentityAppearsInSessionId(participant.id)
    || isSupportIdentityId(participant.ownerIdentityId)
    || isSupportIdentityId(participant.sourceIdentityId)
    || isSupportIdentityId(participant.humanId)
    || isSupportIdentityId(participant.agentId)
  )));
}

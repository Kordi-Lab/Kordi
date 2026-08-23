import type { SessionHydrationState } from '@/features/canonical/canonicalStore';
import { isCanonicalCloudSessionId } from '@/features/canonical/sessionResolver';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import { transcriptLoadingNotice } from '@/features/chat/transcriptLoadingNotice';
import { cloudSystemAgentIdFromSessionId } from '@/features/collaboration/conversationIds';
import {
  cloudConversationKindFromConversationId,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
  isCloudCollaborationConversationId,
} from '@/features/cloud/cloudCollaborationState';
import {
  KORDI_SUPPORT_ACCOUNT_ID,
  KORDI_SUPPORT_AGENT_ID,
  KORDI_SUPPORT_AVATAR_URL,
  KORDI_SUPPORT_NAME,
  KORDI_SUPPORT_SUBTITLE,
  isKordiSupportConversation,
} from '@/features/support/supportIdentity';
import type { Contact, Conversation } from '@/kordi-app/types';

type ActiveConversationSelectionOptions = {
  isNativeShell: boolean;
  nativeChatPlaceholder: Conversation;
  fallbackConversation?: Conversation;
};

export function conversationWithHydratedSupportRoute(
  conversation: Conversation,
  contacts: Contact[] = [],
): Conversation {
  if (!isKordiSupportConversation(conversation)) return conversation;
  const supportContact = contacts.find((contact) => (
    contact.supportTicketEnabled
    && contact.targetCloudAgentId?.trim() === KORDI_SUPPORT_AGENT_ID
  ));
  const ownerAccountId = supportContact?.targetCloudAgentOwnerAccountId?.trim()
    || supportContact?.sourceHumanId?.trim()
    || '';
  if (!supportContact || !ownerAccountId) return conversation;

  const current = conversation.collaborationTarget;
  if (
    current?.agentId === KORDI_SUPPORT_AGENT_ID
    && current.humanId === ownerAccountId
    && current.nodeId === ownerAccountId
  ) return conversation;

  return {
    ...conversation,
    collaborationTarget: {
      hostId: supportContact.sourceHostId?.trim() || current?.hostId || 'cloud',
      nodeId: ownerAccountId,
      displayName: supportContact.targetCloudAgentName?.trim() || KORDI_SUPPORT_NAME,
      ownerName: supportContact.targetCloudAgentOwnerName?.trim() || current?.ownerName || 'Kordi',
      runtime: supportContact.sourceRuntime?.trim() || current?.runtime || 'kordi-desktop',
      humanId: ownerAccountId,
      agentId: KORDI_SUPPORT_AGENT_ID,
    },
  };
}

function matchingConversation(
  activeConvId: string,
  conversations: Conversation[],
): Conversation | undefined {
  const cloudSessionId = isCloudCollaborationConversationId(activeConvId)
    ? cloudSessionIdFromConversationId(activeConvId)
    : null;
  return conversations.find((conversation) => conversation.id === activeConvId)
    ?? conversations.find((conversation) => conversation.canonicalSessionId === activeConvId)
    ?? (cloudSessionId
      ? conversations.find((conversation) => (
          conversation.id === cloudSessionId
          || conversation.canonicalSessionId === cloudSessionId
        ))
      : undefined);
}

function matchingSupportConversation(
  activeConvId: string,
  conversations: Conversation[],
): Conversation | undefined {
  if (
    !isCloudCollaborationConversationId(activeConvId)
    || cloudConversationKindFromConversationId(activeConvId) !== 'agent'
  ) {
    return undefined;
  }
  const activeSessionId = cloudSessionIdFromConversationId(activeConvId);
  const activeSystemAgentId = cloudSystemAgentIdFromSessionId(activeSessionId);
  if (activeSessionId && activeSystemAgentId !== KORDI_SUPPORT_AGENT_ID) {
    return undefined;
  }
  const supportAccountId = cloudPeerAccountIdFromConversationId(activeConvId);
  const exactOwnerMatch = conversations.find((conversation) => (
    isKordiSupportConversation(conversation)
    && conversation.collaborationTarget?.nodeId === supportAccountId
  ));
  if (exactOwnerMatch) {
    return exactOwnerMatch;
  }

  // Older desktop builds persisted either a synthetic owner id or a legacy
  // Support session. The built-in agent identity is stable across both, so a
  // new scoped selection must reuse the existing message-backed contact.
  if (
    supportAccountId !== KORDI_SUPPORT_ACCOUNT_ID
    && activeSystemAgentId !== KORDI_SUPPORT_AGENT_ID
  ) {
    return undefined;
  }
  return conversations.find((conversation) => (
    isKordiSupportConversation(conversation)
    && conversation.collaborationTarget?.agentId === KORDI_SUPPORT_AGENT_ID
  ));
}

export function activeConversationForSelection(
  activeConvId: string,
  chatConversations: Conversation[],
  options: ActiveConversationSelectionOptions,
): Conversation {
  if (options.isNativeShell && isLocalDraftChatConversationId(activeConvId)) {
    return options.nativeChatPlaceholder;
  }
  const selectedConversation = matchingConversation(activeConvId, chatConversations);
  if (selectedConversation) {
    const selectedCanonicalId = selectedConversation.canonicalSessionId ?? selectedConversation.id;
    if (
      isCanonicalCloudSessionId(selectedCanonicalId)
      && selectedConversation.messages.length === 0
      && selectedConversation.canonicalMessageCount !== 0
    ) {
      const pending = pendingCanonicalCloudConversationForActiveId(selectedCanonicalId);
      return pending ? {
        ...selectedConversation,
        subtitle: selectedConversation.subtitle || pending.subtitle,
        messages: pending.messages,
      } : selectedConversation;
    }
    return selectedConversation;
  }
  const supportConversation = matchingSupportConversation(
    activeConvId,
    chatConversations,
  );
  if (supportConversation) return supportConversation;
  const pendingCloudConversation = pendingCloudCollaborationConversationForActiveId(activeConvId);
  if (pendingCloudConversation) return pendingCloudConversation;
  const pendingCanonicalCloudConversation = pendingCanonicalCloudConversationForActiveId(activeConvId);
  if (pendingCanonicalCloudConversation) return pendingCanonicalCloudConversation;
  return options.fallbackConversation
    ?? (options.isNativeShell
      ? options.nativeChatPlaceholder
      : chatConversations[0] ?? options.nativeChatPlaceholder);
}

export function applyCanonicalHydrationPlaceholder(
  selectedConversation: Conversation,
  hydration: SessionHydrationState | undefined,
): Conversation {
  if (
    selectedConversation.desktopRuntimeBacked
    && selectedConversation.desktopRuntimeTranscriptLoaded !== true
    && !isLocalDraftChatConversationId(selectedConversation.id)
    && selectedConversation.messages.every((message) => message.role === 'system')
  ) {
    return {
      ...selectedConversation,
      messages: [transcriptLoadingNotice()],
    };
  }
  const knownCanonicalMessageCount =
    selectedConversation.canonicalMessageCount;
  if (
    typeof knownCanonicalMessageCount !== 'number'
    || knownCanonicalMessageCount <= 0
    || selectedConversation.messages.length >= knownCanonicalMessageCount
    || selectedConversation.desktopRuntimeBacked
    || (hydration !== 'cold' && hydration !== 'loading')
  ) {
    return selectedConversation;
  }
  return {
    ...selectedConversation,
    messages: [transcriptLoadingNotice()],
  };
}

export function pendingCanonicalCloudConversationForActiveId(
  activeConvId: string,
): Conversation | null {
  const sessionId = activeConvId.trim();
  if (!isCanonicalCloudSessionId(sessionId)) return null;
  const isGroup = sessionId.startsWith('session:group:');
  return {
    id: sessionId,
    canonicalSessionId: sessionId,
    name: isGroup ? 'Opening group chat…' : 'Opening Cloud chat…',
    type: isGroup ? 'owned-agent' : 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: isGroup ? 'Group chat' : 'Person chat',
    participants: ['Me'],
    messages: [transcriptLoadingNotice()],
  };
}

export function pendingCloudCollaborationConversationForActiveId(
  activeConvId: string,
): Conversation | null {
  if (!isCloudCollaborationConversationId(activeConvId)) return null;
  const peerId = cloudPeerAccountIdFromConversationId(activeConvId);
  if (!peerId) return null;
  const isAgent = cloudConversationKindFromConversationId(activeConvId) === 'agent';
  const cloudSessionId = cloudSessionIdFromConversationId(activeConvId);
  const systemAgentId = cloudSystemAgentIdFromSessionId(cloudSessionId);
  const isKordiSupport = isAgent && (
    systemAgentId === KORDI_SUPPORT_AGENT_ID
    || (!cloudSessionId && peerId === KORDI_SUPPORT_ACCOUNT_ID)
  );
  const loadingLabel = isAgent ? 'Opening agent chat…' : 'Opening chat with this contact…';
  const displayName = isKordiSupport
    ? KORDI_SUPPORT_NAME
    : isAgent ? 'Opening agent chat…' : 'New contact chat';
  return {
    id: activeConvId,
    canonicalSessionId: undefined,
    name: displayName,
    type: isKordiSupport ? 'person' : isAgent ? 'external-agent' : 'person',
    subtitle: isKordiSupport ? KORDI_SUPPORT_SUBTITLE : '',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: isKordiSupport ? 'Person chat' : isAgent ? 'Agent chat' : 'Person chat',
    participants: isKordiSupport ? ['Me', KORDI_SUPPORT_NAME] : isAgent ? ['Me'] : ['Me', 'Contact'],
    messages: isKordiSupport || !isAgent ? [] : [transcriptLoadingNotice(loadingLabel)],
    supportTicketEnabled: isKordiSupport,
    collaborationTarget: {
      hostId: 'cloud',
      nodeId: peerId,
      displayName: isKordiSupport ? KORDI_SUPPORT_NAME : isAgent ? 'Agent' : 'Contact',
      ownerName: isAgent ? 'Kordi' : 'Contact',
      runtime: isAgent ? 'kordi-desktop' : 'person',
      humanId: peerId,
      agentId: isAgent ? systemAgentId ?? (isKordiSupport ? KORDI_SUPPORT_AGENT_ID : 'pending-cloud-agent') : null,
    },
    avatarSeed: peerId,
    profileImageUrl: isKordiSupport ? KORDI_SUPPORT_AVATAR_URL : null,
  };
}

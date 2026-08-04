import type { SessionHydrationState } from '@/features/canonical/canonicalStore';
import { isCanonicalCloudSessionId } from '@/features/canonical/sessionResolver';
import { isLocalDraftChatConversationId } from '@/features/chat/draftSessions';
import { transcriptLoadingNotice } from '@/features/chat/transcriptLoadingNotice';
import {
  cloudConversationKindFromConversationId,
  cloudPeerAccountIdFromConversationId,
  cloudSessionIdFromConversationId,
  isCloudCollaborationConversationId,
} from '@/features/cloud/cloudCollaborationState';
import type { Conversation } from '@/kordi-app/types';

type ActiveConversationSelectionOptions = {
  isNativeShell: boolean;
  nativeChatPlaceholder: Conversation;
  fallbackConversation?: Conversation;
};

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

function matchingLegacySupportConversation(
  activeConvId: string,
  conversations: Conversation[],
): Conversation | undefined {
  if (
    !isCloudCollaborationConversationId(activeConvId)
    || cloudConversationKindFromConversationId(activeConvId) !== 'agent'
    || cloudSessionIdFromConversationId(activeConvId)
  ) {
    return undefined;
  }
  const supportAccountId = cloudPeerAccountIdFromConversationId(activeConvId);
  return conversations.find((conversation) => (
    conversation.supportTicketEnabled
    && conversation.collaborationTarget?.nodeId === supportAccountId
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
  const legacySupportConversation = matchingLegacySupportConversation(
    activeConvId,
    chatConversations,
  );
  if (legacySupportConversation) return legacySupportConversation;
  const pendingCloudConversation = pendingCloudCollaborationConversationForActiveId(activeConvId);
  if (pendingCloudConversation) return pendingCloudConversation;
  const pendingCanonicalCloudConversation = pendingCanonicalCloudConversationForActiveId(activeConvId);
  if (pendingCanonicalCloudConversation) return pendingCanonicalCloudConversation;
  return chatConversations[0]
    ?? (options.isNativeShell
      ? options.nativeChatPlaceholder
      : options.fallbackConversation ?? options.nativeChatPlaceholder);
}

export function applyCanonicalHydrationPlaceholder(
  selectedConversation: Conversation,
  hydration: SessionHydrationState | undefined,
): Conversation {
  if (
    selectedConversation.desktopRuntimeBacked
    || selectedConversation.canonicalMessageCount === 0
    || selectedConversation.messages.length > 0
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
  const loadingLabel = isAgent ? 'Opening agent chat…' : 'Opening chat with this contact…';
  return {
    id: activeConvId,
    canonicalSessionId: undefined,
    name: isAgent ? 'Opening agent chat…' : 'Opening contact…',
    type: isAgent ? 'external-agent' : 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: isAgent ? 'Agent chat' : 'Person chat',
    participants: ['Me'],
    messages: [transcriptLoadingNotice(loadingLabel)],
    collaborationTarget: {
      hostId: 'cloud',
      nodeId: peerId,
      displayName: isAgent ? 'Agent' : 'Contact',
      ownerName: isAgent ? 'Kordi' : 'Contact',
      runtime: isAgent ? 'kordi-desktop' : 'person',
      humanId: peerId,
      agentId: isAgent ? 'pending-cloud-agent' : null,
    },
    avatarSeed: peerId,
  };
}

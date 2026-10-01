import type { KordiAppFoundation } from '@/app/useKordiAppFoundation';
import { useKordiCanonicalPageHydration } from '@/app/useKordiCanonicalSessionStore';
import type { Conversation } from '@/kordi-app/types';

/** Resolve the displayed chat's canonical session before loading its transcript page. */
export function useSelectedChatHistoryHydration(
  foundation: KordiAppFoundation,
  selectedConversation: Pick<Conversation, 'id' | 'canonicalSessionId'>,
) {
  useKordiCanonicalPageHydration({
    activeConversationId: foundation.navigation.activeConvId,
    activeConversation: selectedConversation,
    activeProjectSessionId: foundation.navigation.activeProjectSessionId,
    collaborationState: foundation.cloud.desktopCollaborationState,
    hydrateSessionPage: foundation.canonical.hydrateCanonicalSessionPage,
    store: foundation.canonical.canonicalStore,
  });
}

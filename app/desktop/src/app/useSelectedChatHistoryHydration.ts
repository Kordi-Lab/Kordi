import { useState } from 'react';
import type { KordiAppFoundation } from '@/app/useKordiAppFoundation';
import { useKordiCanonicalPageHydration } from '@/app/useKordiCanonicalSessionStore';
import type { Conversation } from '@/kordi-app/types';

/**
 * Resolve the displayed chat's canonical session before loading its transcript page.
 * Returns the setter for the side panel's session, whose page loads alongside.
 */
export function useSelectedChatHistoryHydration(
  foundation: KordiAppFoundation,
  selectedConversation: Pick<Conversation, 'id' | 'canonicalSessionId'>,
) {
  const [companionSessionId, setCompanionSessionId] = useState<string | null>(null);
  useKordiCanonicalPageHydration({
    activeConversationId: foundation.navigation.activeConvId,
    activeConversation: selectedConversation,
    activeProjectSessionId: foundation.navigation.activeProjectSessionId,
    companionSessionId,
    collaborationState: foundation.cloud.desktopCollaborationState,
    hydrateSessionPage: foundation.canonical.hydrateCanonicalSessionPage,
    store: foundation.canonical.canonicalStore,
  });
  return setCompanionSessionId;
}

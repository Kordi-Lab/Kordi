import { useEffect } from 'react';

import { acceptedCloudGroupConversationId } from '@/app/acceptedCloudGroupConversationId';
import {
  CLOUD_GROUP_INVITATION_ACCEPTED_EVENT,
  type CloudGroupInvitationAcceptedDetail,
} from '@/features/cloud/groupInvitationDeepLink';
import { DOCUMENT_SESSION_OPEN_EVENT } from '@/features/documents/documentShareToken';

export function useAcceptedCloudGroupNavigation({
  refreshCloudMessages,
  setActiveConversationId,
  setActiveNavigation,
  setDesktopChatError,
}: {
  refreshCloudMessages: () => Promise<unknown>;
  setActiveConversationId: (conversationId: string) => void;
  setActiveNavigation: (navigation: 'chats') => void;
  setDesktopChatError: (message: string | null) => void;
}) {
  useEffect(() => {
    const openAcceptedGroup = (event: Event) => {
      const detail = (event as CustomEvent<CloudGroupInvitationAcceptedDetail>).detail;
      const conversationId = acceptedCloudGroupConversationId(detail?.groupSpaceId);
      if (!conversationId) return;
      // A sidebar click clears the previous chat's banner; opening from
      // Common ground or an invite must too, or it shows over the new group.
      setDesktopChatError(null);
      void refreshCloudMessages()
        .then(() => {
          setActiveNavigation('chats');
          setActiveConversationId(conversationId);
        })
        .catch((error) => {
          setDesktopChatError(
            error instanceof Error
              ? error.message
              : 'The group joined, but Kordi could not open it yet.',
          );
        });
    };
    // **Open in session** from a shared document link.
    const openDocumentSession = (event: Event) => {
      const sessionId = (event as CustomEvent<string>).detail?.trim();
      if (!sessionId) return;
      setActiveNavigation('chats');
      setActiveConversationId(sessionId);
    };
    window.addEventListener(
      CLOUD_GROUP_INVITATION_ACCEPTED_EVENT,
      openAcceptedGroup,
    );
    window.addEventListener(DOCUMENT_SESSION_OPEN_EVENT, openDocumentSession);
    return () => {
      window.removeEventListener(
        CLOUD_GROUP_INVITATION_ACCEPTED_EVENT,
        openAcceptedGroup,
      );
      window.removeEventListener(DOCUMENT_SESSION_OPEN_EVENT, openDocumentSession);
    };
  }, [
    refreshCloudMessages,
    setActiveConversationId,
    setActiveNavigation,
    setDesktopChatError,
  ]);
}

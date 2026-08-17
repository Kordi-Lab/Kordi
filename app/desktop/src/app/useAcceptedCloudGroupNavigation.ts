import { useEffect } from 'react';

import {
  CLOUD_GROUP_INVITATION_ACCEPTED_EVENT,
  type CloudGroupInvitationAcceptedDetail,
} from '@/features/cloud/groupInvitationDeepLink';

export function useAcceptedCloudGroupNavigation({
  refreshCloudMessages,
  setActiveConversationId,
  setActiveNavigation,
  setDesktopChatError,
}: {
  refreshCloudMessages: () => Promise<unknown>;
  setActiveConversationId: (conversationId: string) => void;
  setActiveNavigation: (navigation: 'chats') => void;
  setDesktopChatError: (message: string) => void;
}) {
  useEffect(() => {
    const openAcceptedGroup = (event: Event) => {
      const detail = (event as CustomEvent<CloudGroupInvitationAcceptedDetail>).detail;
      const groupSpaceId = detail?.groupSpaceId?.trim();
      if (!groupSpaceId) return;
      void refreshCloudMessages()
        .then(() => {
          setActiveNavigation('chats');
          setActiveConversationId(`group:${groupSpaceId}`);
        })
        .catch((error) => {
          setDesktopChatError(
            error instanceof Error
              ? error.message
              : 'The group joined, but Kordi could not open it yet.',
          );
        });
    };
    window.addEventListener(
      CLOUD_GROUP_INVITATION_ACCEPTED_EVENT,
      openAcceptedGroup,
    );
    return () => window.removeEventListener(
      CLOUD_GROUP_INVITATION_ACCEPTED_EVENT,
      openAcceptedGroup,
    );
  }, [
    refreshCloudMessages,
    setActiveConversationId,
    setActiveNavigation,
    setDesktopChatError,
  ]);
}

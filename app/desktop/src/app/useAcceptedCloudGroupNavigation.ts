import { useEffect, useRef } from 'react';

import { acceptedCloudGroupConversationId } from '@/app/acceptedCloudGroupConversationId';
import {
  CLOUD_GROUP_INVITATION_ACCEPTED_EVENT,
  type CloudGroupInvitationAcceptedDetail,
} from '@/features/cloud/groupInvitationDeepLink';
import { DOCUMENT_SESSION_OPEN_EVENT } from '@/features/documents/documentShareToken';

export const ACCEPTED_GROUP_WAIT_ATTEMPTS = 20;
export const ACCEPTED_GROUP_WAIT_INTERVAL_MS = 250;
export const ACCEPTED_GROUP_SYNCING_NOTICE = 'This group is still syncing.';

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export function useAcceptedCloudGroupNavigation({
  activeConversationId,
  hasConversation,
  refreshCloudMessages,
  setActiveConversationId,
  setActiveNavigation,
  setDesktopChatError,
  waitAttempts = ACCEPTED_GROUP_WAIT_ATTEMPTS,
  waitIntervalMs = ACCEPTED_GROUP_WAIT_INTERVAL_MS,
}: {
  activeConversationId: string;
  /** True once the chat list (the navigation index) holds this session id. */
  hasConversation: (conversationId: string) => boolean;
  refreshCloudMessages: () => Promise<unknown>;
  setActiveConversationId: (conversationId: string) => void;
  setActiveNavigation: (navigation: 'chats') => void;
  setDesktopChatError: (message: string | null) => void;
  waitAttempts?: number;
  waitIntervalMs?: number;
}) {
  // Read at call time: the chat list and sync callbacks change while an
  // open request waits, and re-subscribing must not cancel that request.
  const argsRef = useRef({
    activeConversationId, hasConversation, refreshCloudMessages, setActiveConversationId, setActiveNavigation,
    setDesktopChatError, waitAttempts, waitIntervalMs,
  });
  useEffect(() => {
    argsRef.current = {
      activeConversationId, hasConversation, refreshCloudMessages, setActiveConversationId, setActiveNavigation,
      setDesktopChatError, waitAttempts, waitIntervalMs,
    };
  });

  useEffect(() => {
    let disposed = false;
    let latestRequest = 0;
    const args = () => argsRef.current;
    const openAcceptedGroup = async (event: Event) => {
      const detail = (event as CustomEvent<CloudGroupInvitationAcceptedDetail>).detail;
      const conversationId = acceptedCloudGroupConversationId(detail?.groupSpaceId);
      if (!conversationId) return;
      const request = ++latestRequest;
      const current = () => !disposed && request === latestRequest;
      // A sidebar click clears the previous chat's banner; opening from
      // Common ground or an invite must too, or it shows over the new group.
      args().setDesktopChatError(null);
      const refresh: { done: boolean; error: unknown } = { done: false, error: null };
      void args().refreshCloudMessages().then(
        () => { refresh.done = true; },
        (error: unknown) => { refresh.done = true; refresh.error = error ?? new Error(); },
      );
      // The refresh resolves before the group's session reaches the chat
      // list (the group catalog is applied after it), and switching to Chats
      // while the id is unknown lets navigation fall back to the first chat.
      // Select only once the list holds the group, within a bounded wait.
      let waitedAfterRefresh = 0;
      while (!args().hasConversation(conversationId)) {
        if (refresh.done) {
          if (refresh.error) {
            if (current()) {
              args().setDesktopChatError(refresh.error instanceof Error && refresh.error.message
                ? refresh.error.message
                : 'The group joined, but Kordi could not open it yet.');
            }
            return;
          }
          if (waitedAfterRefresh >= args().waitAttempts) break;
          waitedAfterRefresh += 1;
        }
        await wait(args().waitIntervalMs);
        if (!current()) return;
      }
      if (!current()) return;
      const { hasConversation: has, setActiveNavigation: setNav, setActiveConversationId: select } = args();
      const found = has(conversationId);
      setNav('chats');
      select(conversationId);
      // Not synced in time: the pending group placeholder stays selected and
      // becomes the group when it arrives.
      if (!found) args().setDesktopChatError(ACCEPTED_GROUP_SYNCING_NOTICE);
      // Navigation drops a selection that leaves the chat list and moves to
      // the first chat. If the new group drops out briefly while its session
      // settles, select it again when it returns.
      let missing = false;
      for (let tick = 0; tick < args().waitAttempts; tick += 1) {
        await wait(args().waitIntervalMs);
        if (!current()) return;
        const present = args().hasConversation(conversationId);
        if (!present) { missing = true; continue; }
        if (missing && args().activeConversationId !== conversationId) {
          args().setActiveNavigation('chats');
          args().setActiveConversationId(conversationId);
          return;
        }
      }
    };
    const onAcceptedGroup = (event: Event) => { void openAcceptedGroup(event); };
    // **Open in session** from a shared document link.
    const openDocumentSession = (event: Event) => {
      const sessionId = (event as CustomEvent<string>).detail?.trim();
      if (!sessionId) return;
      args().setActiveNavigation('chats');
      args().setActiveConversationId(sessionId);
    };
    window.addEventListener(CLOUD_GROUP_INVITATION_ACCEPTED_EVENT, onAcceptedGroup);
    window.addEventListener(DOCUMENT_SESSION_OPEN_EVENT, openDocumentSession);
    return () => {
      disposed = true;
      window.removeEventListener(CLOUD_GROUP_INVITATION_ACCEPTED_EVENT, onAcceptedGroup);
      window.removeEventListener(DOCUMENT_SESSION_OPEN_EVENT, openDocumentSession);
    };
  }, []);
}

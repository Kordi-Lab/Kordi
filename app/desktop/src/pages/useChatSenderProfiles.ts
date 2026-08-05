import { useCallback, useState } from 'react';

import { useCloudContacts } from '@/features/cloud/useCloudContacts';
import type { CloudSupportTicketInput } from '@/features/cloud/supportClient';
import type {
  Contact,
  Conversation,
  ConversationParticipant,
  Message,
} from '@/kordi-app/types';
import { transcriptHumanParticipant } from '@/pages/chatsPage.model';
import type {
  ChatsPageRuntime,
  ChatsPageSession,
} from '@/pages/chatsPage.types';

type SenderProfileTarget = {
  participant: ConversationParticipant;
  anchorRect: DOMRect;
};

type SenderProfileState = {
  pageConversationId: string;
  target: SenderProfileTarget | null;
};

type UseChatSenderProfilesInput = {
  activeConversation: Conversation;
  companionConversation: Conversation | null;
  cloudAccount: ChatsPageSession['cloudAccount'];
  onMessageContact: ChatsPageRuntime['onMessageContact'];
};

export function useChatSenderProfiles({
  activeConversation,
  companionConversation,
  cloudAccount,
  onMessageContact,
}: UseChatSenderProfilesInput) {
  const normalizedCloudAccount = cloudAccount ?? null;
  const cloudContacts = useCloudContacts(normalizedCloudAccount);
  const submitCloudSupportRequest = cloudContacts.submitSupportRequest;
  const getCloudSupportRequest = cloudContacts.getSupportRequest;
  const [storedState, setStoredState] = useState<SenderProfileState>({
    pageConversationId: activeConversation.id,
    target: null,
  });
  const state = storedState.pageConversationId === activeConversation.id
    ? storedState
    : {
        pageConversationId: activeConversation.id,
        target: null,
      };
  if (state !== storedState) {
    setStoredState(state);
  }

  const open = useCallback((
    conversation: Conversation,
    message: Message,
    anchorRect: DOMRect,
  ) => {
    const participant = transcriptHumanParticipant(conversation, message);
    if (!participant || participant.role === 'self') return;
    setStoredState({
      pageConversationId: activeConversation.id,
      target: { participant, anchorRect },
    });
  }, [activeConversation.id]);
  const openActive = useCallback(
    (message: Message, anchorRect: DOMRect) => {
      open(activeConversation, message, anchorRect);
    },
    [activeConversation, open],
  );
  const openCompanion = useCallback(
    (message: Message, anchorRect: DOMRect) => {
      if (!companionConversation) return;
      open(companionConversation, message, anchorRect);
    },
    [companionConversation, open],
  );
  const messageContact = useCallback(async (contact: Contact) => {
    if (!onMessageContact) return;
    setStoredState({
      pageConversationId: activeConversation.id,
      target: null,
    });
    await onMessageContact(contact);
  }, [activeConversation.id, onMessageContact]);
  const submitSupportRequest = useCallback(
    (input: CloudSupportTicketInput) => submitCloudSupportRequest(input),
    [submitCloudSupportRequest],
  );
  const getSupportRequest = useCallback(
    (clientSubmissionId: string) => getCloudSupportRequest(clientSubmissionId),
    [getCloudSupportRequest],
  );

  return {
    target: state.target,
    contacts: cloudContacts.contacts,
    sendRequest: normalizedCloudAccount
      ? (peerAccountId: string, message?: string) => (
          cloudContacts.sendRequest(peerAccountId, message)
        )
      : undefined,
    messageContact: onMessageContact ? messageContact : undefined,
    submitSupportRequest: normalizedCloudAccount
      ? submitSupportRequest
      : undefined,
    getSupportRequest: normalizedCloudAccount
      ? getSupportRequest
      : undefined,
    supportAccountId: normalizedCloudAccount?.accountId,
    openActive,
    openCompanion,
    close: () => setStoredState({
      pageConversationId: activeConversation.id,
      target: null,
    }),
  };
}

import { useCallback, useState } from 'react';

import { useCloudContacts } from '@/features/cloud/useCloudContacts';
import type { CloudSupportTicketInput } from '@/features/cloud/supportClient';
import type {
  Contact,
  Conversation,
  ConversationParticipant,
  Message,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';
import { transcriptHumanParticipant } from '@/pages/chatsPage.model';
import type {
  ChatsPageRuntime,
  ChatsPageSession,
} from '@/pages/chatsPage.types';

type SenderProfileTarget = {
  participant: ConversationParticipant;
  conversation: Conversation;
  anchorRect: DOMRect;
};

type SenderProfileState = {
  pageConversationId: string;
  target: SenderProfileTarget | null;
};

type UseChatSenderProfilesInput = {
  activeConversation: Conversation;
  companionConversation: Conversation | null;
  participantSpaces: ParticipantSpaceViewModel[];
  cloudAccount: ChatsPageSession['cloudAccount'];
  onMessageContact: ChatsPageRuntime['onMessageContact'];
};

function participantIdentityKeys(participant: ConversationParticipant) {
  return new Set([
    participant.id,
    participant.humanId,
    participant.sourceIdentityId,
  ].map((value) => value?.trim()).filter(Boolean));
}

function groupContainsParticipant(
  space: ParticipantSpaceViewModel,
  participant: ConversationParticipant,
) {
  const keys = participantIdentityKeys(participant);
  return space.kind === 'group' && space.participants.some((member) => [
    member.id,
    member.humanId,
    member.sourceIdentityId,
  ].some((value) => Boolean(value?.trim() && keys.has(value.trim()))));
}

export function useChatSenderProfiles({
  activeConversation,
  companionConversation,
  participantSpaces,
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
      target: { participant, conversation, anchorRect },
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
  const close = useCallback(() => setStoredState({
    pageConversationId: activeConversation.id,
    target: null,
  }), [activeConversation.id]);
  const commonGroupCount = state.target
    ? participantSpaces.filter((space) => (
        groupContainsParticipant(space, state.target!.participant)
      )).length
    : 0;

  return {
    target: state.target,
    commonGroupCount,
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
    close,
  };
}

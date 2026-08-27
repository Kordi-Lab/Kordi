import { createContext, useCallback, useState } from 'react';

import { useCloudContacts } from '@/features/cloud/useCloudContacts';
import type { CloudPresenceStore } from '@/features/cloud/presence';
import type { CloudSupportTicketInput } from '@/features/cloud/supportClient';
import type {
  Contact,
  Conversation,
  ConversationParticipant,
  Message,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';
import { transcriptHumanParticipant } from '@/pages/chatSenderProfileModel';
import {
  contactForGroupMember,
  groupMemberAccountId,
} from '@/pages/memberContactProfileModel';
import type {
  ChatsPageRuntime,
  ChatsPageSession,
} from '@/pages/chatsPage.types';

type SenderProfileTarget = {
  participant: ConversationParticipant;
  conversation: Conversation;
  anchorRect: DOMRect;
};

export type ChatSenderProfileOpener = (
  conversation: Conversation,
  participant: ConversationParticipant,
  anchorRect: DOMRect,
) => void;

export const ChatSenderProfileContext = createContext<ChatSenderProfileOpener | null>(null);

type SenderProfileState = {
  pageConversationId: string;
  target: SenderProfileTarget | null;
};

type UseChatSenderProfilesInput = {
  activeConversation: Conversation;
  companionConversation: Conversation | null;
  participantSpaces: ParticipantSpaceViewModel[];
  cloudAccount: ChatsPageSession['cloudAccount'];
  presenceSnapshot: CloudPresenceStore;
  onMessageContact: ChatsPageRuntime['onMessageContact'];
  onSelectSession: ChatsPageRuntime['onSelectSession'];
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
  presenceSnapshot,
  onMessageContact,
  onSelectSession,
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

  const openParticipant = useCallback<ChatSenderProfileOpener>((
    conversation,
    participant,
    anchorRect,
  ) => {
    if (participant.kind !== 'human' || participant.role === 'self') return;
    setStoredState({
      pageConversationId: activeConversation.id,
      target: { participant, conversation, anchorRect },
    });
  }, [activeConversation.id]);
  const open = useCallback((
    conversation: Conversation,
    message: Message,
    anchorRect: DOMRect,
  ) => {
    const participant = transcriptHumanParticipant(conversation, message);
    if (participant) openParticipant(conversation, participant, anchorRect);
  }, [openParticipant]);
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
  const commonGroups = state.target
    ? participantSpaces.filter((space) => (
        groupContainsParticipant(space, state.target!.participant)
      ))
    : [];
  const targetContact = state.target
    ? contactForGroupMember(cloudContacts.contacts, state.target.participant)
    : null;
  const targetAccountId = state.target
    ? groupMemberAccountId(state.target.participant, targetContact)
    : '';
  const targetPresence = state.target && targetAccountId
    ? presenceSnapshot[targetAccountId] ?? null
    : undefined;
  const openCommonGroup = useCallback((space: ParticipantSpaceViewModel) => {
    const sessionId = space.sessions[0]?.id;
    if (!sessionId || !onSelectSession) return;
    setStoredState({
      pageConversationId: activeConversation.id,
      target: null,
    });
    onSelectSession(sessionId);
  }, [activeConversation.id, onSelectSession]);

  return {
    target: state.target,
    presence: targetPresence,
    commonGroups,
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
    openParticipant,
    openActive,
    openCompanion,
    openCommonGroup: onSelectSession ? openCommonGroup : undefined,
    close,
  };
}

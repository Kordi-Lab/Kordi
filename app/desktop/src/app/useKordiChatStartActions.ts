import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { cloudCollaborationConversationId } from '@/features/cloud/cloudCollaborationState';
import { cloudSystemAgentConversationId } from '@/features/collaboration/conversationIds';
import { CLOUD_HOST_SENTINEL } from '@/features/cloud/useCloudContacts';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import type { ComposerDraftState } from '@/features/chat/composerDrafts';
import { updateScopeDraft } from '@/features/chat/composerDrafts';
import {
  agentCanonicalIdentityRequest,
  buildChatAgentSessionKind,
  buildChatAgentSessionMetadata,
  chatSessionIdForAgentStart,
  chatSessionIdForPersonStart,
  contactCanonicalIdentityRequest,
  existingBlankSessionIdForAgentStart,
  existingSessionIdForPersonStart,
} from '@/features/chat/chatCreateFlows';
import type {
  Agent,
  CanonicalSessionState,
  ComposerScope,
  ComposerSelectorType,
  Contact,
  Conversation,
  NavId,
} from '@/kordi-app/types';
import {
  openOrCreateCanonicalSessionFast,
  upsertCanonicalIdentityFast,
} from '@/lib/desktop';

import {
  mergeCanonicalIdentity,
  mergeOpenCanonicalSessionResult,
} from './canonicalSessionStateMutations';

type CollaborationPersonTarget = {
  hostId: string;
  nodeId: string;
  displayName?: string | null;
  ownerName?: string | null;
  humanId?: string | null;
};

type UseKordiChatStartActionsArgs = {
  canonicalState: CanonicalSessionState | null;
  cloudAccountId?: string | null;
  conversations: Conversation[];
  isNativeShell: boolean;
  hasAgentProvider: boolean;
  createOwnedAgentSession: () => Promise<void>;
  openAgentAuthentication: () => void;
  startCollaborationPersonSession: (
    target: CollaborationPersonTarget,
  ) => Promise<void>;
  setActiveConversationId: Dispatch<SetStateAction<string>>;
  setActiveNav: Dispatch<SetStateAction<NavId>>;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  setComposerAttachments: Dispatch<SetStateAction<AttachmentItem[]>>;
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftState>>;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
  setOpenComposerSelector: Dispatch<SetStateAction<{
    scope: ComposerScope;
    type: ComposerSelectorType;
  } | null>>;
};

export function useKordiChatStartActions({
  canonicalState,
  cloudAccountId,
  conversations,
  isNativeShell,
  hasAgentProvider,
  createOwnedAgentSession,
  openAgentAuthentication,
  startCollaborationPersonSession,
  setActiveConversationId,
  setActiveNav,
  setCanonicalState,
  setComposerAttachments,
  setComposerDrafts,
  setDesktopError,
  setOpenComposerSelector,
}: UseKordiChatStartActionsArgs) {
  const selectNewSession = useCallback((sessionId: string) => {
    setActiveNav('chats');
    setActiveConversationId(sessionId);
    setComposerDrafts((current) => updateScopeDraft(
      current,
      'chat',
      sessionId,
      '',
    ));
    setComposerAttachments([]);
    setOpenComposerSelector(null);
  }, [
    setActiveConversationId,
    setActiveNav,
    setComposerAttachments,
    setComposerDrafts,
    setOpenComposerSelector,
  ]);

  const startChatWithPerson = useCallback(async (contact: Contact) => {
    setDesktopError(null);
    if (
      contact.sourceHostId === CLOUD_HOST_SENTINEL
      && contact.sourceParticipantId
    ) {
      if (contact.systemContact && contact.sourceAgentId) {
        const accountId = cloudAccountId?.trim();
        if (!accountId) {
          setDesktopError(`${contact.name || 'Kordi Support'} is still loading. Try again.`);
          return;
        }
        selectNewSession(cloudSystemAgentConversationId(
          accountId,
          contact.sourceParticipantId,
          contact.sourceAgentId,
        ));
        return;
      }
      selectNewSession(cloudCollaborationConversationId(
        contact.sourceParticipantId,
        contact.sourceRuntime ?? 'person',
      ));
      return;
    }
    if (contact.sourceHostId && contact.sourceParticipantId) {
      await startCollaborationPersonSession({
        hostId: contact.sourceHostId,
        nodeId: contact.sourceParticipantId,
        displayName: contact.name,
        ownerName: contact.owner,
        humanId: contact.sourceHumanId,
      });
      return;
    }

    if (!isNativeShell) return;
    const existingSessionId = existingSessionIdForPersonStart(
      contact,
      conversations,
    );
    if (existingSessionId) {
      selectNewSession(existingSessionId);
      return;
    }
    const creatorIdentityId =
      canonicalState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const identityRequest = contactCanonicalIdentityRequest(contact);
    const targetIdentityId = identityRequest.id?.trim();
    if (!targetIdentityId) {
      throw new Error('Unable to resolve contact identity.');
    }
    const identity = await upsertCanonicalIdentityFast(identityRequest);
    setCanonicalState((current) => current
      ? mergeCanonicalIdentity(current, identity)
      : current);
    const sessionId = chatSessionIdForPersonStart(crypto.randomUUID());
    const openResult = await openOrCreateCanonicalSessionFast({
      id: sessionId,
      kind: 'direct-person',
      title: 'New session',
      status: 'active',
      createdByIdentityId: creatorIdentityId,
      primaryIdentityId: targetIdentityId,
      relationshipIdentityId: targetIdentityId,
      participantIdentityIds: [targetIdentityId],
      metadata: {
        createdFrom: 'chat-create-flow',
        contactId: contact.id,
        participantSpaceKind: 'direct-human',
      },
    });
    setCanonicalState((current) => current
      ? mergeOpenCanonicalSessionResult(current, openResult)
      : current);
    selectNewSession(sessionId);
  }, [
    canonicalState?.profile.humanIdentityId,
    cloudAccountId,
    conversations,
    isNativeShell,
    selectNewSession,
    setCanonicalState,
    setDesktopError,
    startCollaborationPersonSession,
  ]);

  const startChatWithAgent = useCallback(async (agent: Agent) => {
    setDesktopError(null);
    if (!hasAgentProvider) {
      openAgentAuthentication();
      return;
    }
    setActiveNav('chats');

    if (agent.isOwned) {
      if (!isNativeShell) {
        await createOwnedAgentSession();
        return;
      }
      const creatorIdentityId =
        canonicalState?.profile.humanIdentityId?.trim();
      if (!creatorIdentityId) {
        throw new Error('Local profile identity is not ready yet.');
      }
      const existingBlankSessionId =
        existingBlankSessionIdForAgentStart(agent, conversations);
      if (existingBlankSessionId) {
        selectNewSession(existingBlankSessionId);
        return;
      }
      await startCanonicalAgentSession({
        agent,
        creatorIdentityId,
        selectNewSession,
        setCanonicalState,
      });
      return;
    }

    if (
      agent.sourceHostId === CLOUD_HOST_SENTINEL
      && agent.sourceParticipantId
    ) {
      selectNewSession(cloudCollaborationConversationId(
        agent.sourceParticipantId,
        agent.sourceRuntime ?? 'kordi-desktop',
      ));
      return;
    }

    if (!isNativeShell) return;
    const creatorIdentityId =
      canonicalState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }
    await startCanonicalAgentSession({
      agent,
      creatorIdentityId,
      selectNewSession,
      setCanonicalState,
    });
  }, [
    canonicalState?.profile.humanIdentityId,
    conversations,
    createOwnedAgentSession,
    hasAgentProvider,
    isNativeShell,
    openAgentAuthentication,
    selectNewSession,
    setActiveNav,
    setCanonicalState,
    setDesktopError,
  ]);

  return {
    selectNewSession,
    startChatWithPerson,
    startChatWithAgent,
  };
}

async function startCanonicalAgentSession({
  agent,
  creatorIdentityId,
  selectNewSession,
  setCanonicalState,
}: {
  agent: Agent;
  creatorIdentityId: string;
  selectNewSession: (sessionId: string) => void;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
}) {
  const identityRequest = agentCanonicalIdentityRequest(agent);
  const targetIdentityId = identityRequest.id?.trim();
  if (!targetIdentityId) {
    throw new Error('Unable to resolve agent identity.');
  }
  const identity = await upsertCanonicalIdentityFast(identityRequest);
  setCanonicalState((current) => current
    ? mergeCanonicalIdentity(current, identity)
    : current);
  const sessionId = chatSessionIdForAgentStart(agent, crypto.randomUUID());
  const openResult = await openOrCreateCanonicalSessionFast({
    id: sessionId,
    kind: buildChatAgentSessionKind(agent),
    title: agent.name || 'New session',
    status: 'active',
    createdByIdentityId: creatorIdentityId,
    primaryIdentityId: targetIdentityId,
    relationshipIdentityId: null,
    participantIdentityIds: [targetIdentityId],
    metadata: buildChatAgentSessionMetadata(agent),
  });
  setCanonicalState((current) => current
    ? mergeOpenCanonicalSessionResult(current, openResult)
    : current);
  selectNewSession(sessionId);
}

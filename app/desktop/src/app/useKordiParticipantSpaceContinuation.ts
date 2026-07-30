import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';

import {
  buildParticipantSpaceContinuationMetadata,
  chatSessionIdForParticipantSpaceContinuation,
  existingBlankSessionIdForParticipantSpace,
} from '@/features/chat/chatCreateFlows';
import { participantSpaceCustomGroupTitle } from '@/features/chat/participantSpaces';
import type {
  CanonicalSessionState,
  Conversation,
  NavId,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';
import { openOrCreateCanonicalSessionFast } from '@/lib/desktop';

import { mergeOpenCanonicalSessionResult } from './canonicalSessionStateMutations';
import {
  canonicalGroupCreatorIdentityId,
  metadataGroupSpaceId,
  metadataStringArray,
  normalizeStoredGroupSpaceId,
  participantSpaceCreateKey,
  participantSpaceNonSelfIdentities,
  sessionMetadataRecord,
  uniqueStrings,
} from './useKordiAppModelHelpers';

export type ParticipantSpaceDraft = {
  createKey: string;
  sessionId: string;
  participantIdentityIds: string[];
  conversation: Conversation;
};

type MutableValue<T> = {
  current: T;
};

type UseKordiParticipantSpaceContinuationArgs = {
  canonicalState: CanonicalSessionState | null;
  createOwnedAgentSession: () => Promise<unknown>;
  draftByKeyRef: MutableValue<Map<string, ParticipantSpaceDraft>>;
  draftBySessionIdRef: MutableValue<Map<string, ParticipantSpaceDraft>>;
  isNativeShell: boolean;
  pendingCreateRef: MutableValue<Map<string, string>>;
  selectNewSession: (sessionId: string) => void;
  setActiveConversationId: Dispatch<SetStateAction<string>>;
  setActiveNav: Dispatch<SetStateAction<NavId>>;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
  setDrafts: Dispatch<SetStateAction<ParticipantSpaceDraft[]>>;
};

export function useKordiParticipantSpaceContinuation({
  canonicalState,
  createOwnedAgentSession,
  draftByKeyRef,
  draftBySessionIdRef,
  isNativeShell,
  pendingCreateRef,
  selectNewSession,
  setActiveConversationId,
  setActiveNav,
  setCanonicalState,
  setDesktopError,
  setDrafts,
}: UseKordiParticipantSpaceContinuationArgs) {
  return useCallback(async (space: ParticipantSpaceViewModel) => {
    if (space.kind === 'self') {
      await createOwnedAgentSession();
      return;
    }

    const existingBlankSessionId = space.kind === 'group'
      ? null
      : existingBlankSessionIdForParticipantSpace(space);
    if (existingBlankSessionId) {
      selectNewSession(existingBlankSessionId);
      return;
    }

    if (!isNativeShell) return;
    setDesktopError(null);

    const creatorIdentityId =
      canonicalState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId || !canonicalState) {
      throw new Error('Local profile identity is not ready yet.');
    }

    const sourceSession = space.sessions[0] ?? null;
    const sourceSessionId =
      sourceSession?.canonicalSessionId ?? sourceSession?.id ?? null;
    const sourceMetadata = sourceSessionId
      ? sessionMetadataRecord(canonicalState, sourceSessionId)
      : {};
    const sessionId = chatSessionIdForParticipantSpaceContinuation(
      space,
      crypto.randomUUID(),
    );
    const createKey = participantSpaceCreateKey(space);

    if (space.kind === 'group') {
      const existingDraft = draftByKeyRef.current.get(createKey);
      if (existingDraft) {
        setActiveNav('chats');
        setActiveConversationId(existingDraft.sessionId);
        return;
      }

      const members = participantSpaceNonSelfIdentities(space, 'human');
      const participantIdentityIds = uniqueStrings(
        members.map((member) => member.id),
      );
      if (participantIdentityIds.length < 2) {
        throw new Error('A group session needs at least 2 other people.');
      }

      const customName = participantSpaceCustomGroupTitle(space) || null;
      const groupCreatorIdentityId = sourceSessionId
        ? space.groupCreatorIdentityId?.trim()
          || canonicalGroupCreatorIdentityId(
            canonicalState,
            sourceSessionId,
          )
          || creatorIdentityId
        : creatorIdentityId;
      const groupSourceMetadata = { ...sourceMetadata };
      delete groupSourceMetadata.titleSource;
      delete groupSourceMetadata.sessionTitleSource;
      delete groupSourceMetadata.cloudUnreadCount;
      const participantNames = members.map((member) => member.name);
      const groupSpaceId =
        metadataGroupSpaceId(sourceMetadata)
        || normalizeStoredGroupSpaceId(space.id)
        || sourceSessionId
        || sessionId;
      const metadata = {
        ...groupSourceMetadata,
        schemaVersion: 1,
        kind: 'chat-group',
        customName,
        groupId: groupSpaceId,
        groupSpaceId,
        groupCreatorIdentityId,
        adminIdentityIds: uniqueStrings([
          groupCreatorIdentityId,
          ...(space.groupAdminIdentityIds ?? []),
        ]),
        initialContactIds: metadataStringArray(
          sourceMetadata,
          'initialContactIds',
        ),
        initialParticipantNames: uniqueStrings([
          ...metadataStringArray(
            sourceMetadata,
            'initialParticipantNames',
          ),
          ...participantNames,
        ]),
        memberApprovalPolicy: 'under-50-open',
        createdFrom: 'chat-create-flow',
        continuedFromSessionId: sourceSessionId,
        continuedFromSpaceId: space.id,
      };
      const primaryParticipant = members[0] ?? space.participants[0];
      const conversation: Conversation = {
        id: sessionId,
        transientDraft: true,
        _updatedAtMs: Date.now(),
        canonicalSessionId: sessionId,
        canonicalCreatedByIdentityId: groupCreatorIdentityId,
        canonicalParticipantCount: space.participants.length,
        canonicalMessageCount: 0,
        name: 'New session',
        type: 'person',
        subtitle: '',
        unread: 0,
        collaborationSources: space.participants.some(
          (participant) => (
            participant.sourceHostId || participant.sourceIdentityId
          ),
        )
          ? ['Cloud']
          : ['Local'],
        trust: 'Cloud',
        directness: 'Group chat',
        participants: space.participants.map(
          (participant) => participant.name,
        ),
        canonicalParticipants: space.participants,
        messages: [],
        updatedAtLabel: 'Draft',
        avatarSeed:
          primaryParticipant?.avatarKey ?? primaryParticipant?.id ?? null,
        profileImageUrl: primaryParticipant?.profileImageUrl ?? null,
        participantSpaceId: `group:${groupSpaceId}`,
        metadata,
      };
      const draft: ParticipantSpaceDraft = {
        createKey,
        sessionId,
        participantIdentityIds,
        conversation,
      };
      draftByKeyRef.current.set(createKey, draft);
      draftBySessionIdRef.current.set(sessionId, draft);
      setDrafts((current) => [
        ...current.filter(
          (candidate) => candidate.createKey !== createKey,
        ),
        draft,
      ]);
      selectNewSession(sessionId);
      return;
    }

    const pendingSessionId = pendingCreateRef.current.get(createKey);
    if (pendingSessionId) {
      selectNewSession(pendingSessionId);
      return;
    }
    pendingCreateRef.current.set(createKey, sessionId);

    try {
      const receiver = participantSpaceNonSelfIdentities(space)[0];
      if (!receiver) {
        pendingCreateRef.current.delete(createKey);
        await createOwnedAgentSession();
        return;
      }

      const kind =
        receiver.kind === 'agent' ? 'direct-agent' : 'direct-person';
      const openResult = await openOrCreateCanonicalSessionFast({
        id: sessionId,
        kind,
        title: 'New session',
        status: 'active',
        createdByIdentityId: creatorIdentityId,
        primaryIdentityId: receiver.id,
        relationshipIdentityId: receiver.id,
        participantIdentityIds: [receiver.id],
        metadata: buildParticipantSpaceContinuationMetadata({
          sourceMetadata,
          continuedFromSessionId: sourceSessionId,
          continuedFromSpaceId: space.id,
          participantSpaceKind: space.kind,
        }),
      });
      const nextState = mergeOpenCanonicalSessionResult(
        canonicalState,
        openResult,
      );
      setCanonicalState(nextState);
      selectNewSession(sessionId);
    } catch (error) {
      pendingCreateRef.current.delete(createKey);
      throw error;
    }
  }, [
    canonicalState,
    createOwnedAgentSession,
    draftByKeyRef,
    draftBySessionIdRef,
    isNativeShell,
    pendingCreateRef,
    selectNewSession,
    setActiveConversationId,
    setActiveNav,
    setCanonicalState,
    setDesktopError,
    setDrafts,
  ]);
}

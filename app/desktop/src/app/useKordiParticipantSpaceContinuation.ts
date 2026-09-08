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
import type { CloudAccount } from '@/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '@/features/cloud/cloudGroupControl.types';
import { createGroupChannel } from './createGroupChannel';
import type {
  CanonicalSessionState,
  Conversation,
  ParticipantSpaceViewModel,
} from '@/kordi-app/types';
import { openOrCreateCanonicalSessionFast } from '@/lib/desktop';

import { mergeOpenCanonicalSessionResult } from './canonicalSessionStateMutations';
import {
  participantSpaceCreateKey,
  participantSpaceNonSelfIdentities,
  sessionMetadataRecord,
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
  account: CloudAccount | null;
  sendCloudGroupControl: (input: SendCloudGroupControlInput) => Promise<void>;
  createOwnedAgentSession: () => Promise<unknown>;
  isNativeShell: boolean;
  pendingCreateRef: MutableValue<Map<string, string>>;
  selectNewSession: (sessionId: string) => void;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
};

export function useKordiParticipantSpaceContinuation({
  canonicalState,
  account,
  sendCloudGroupControl,
  createOwnedAgentSession,
  isNativeShell,
  pendingCreateRef,
  selectNewSession,
  setCanonicalState,
  setDesktopError,
}: UseKordiParticipantSpaceContinuationArgs) {
  return useCallback(async (space: ParticipantSpaceViewModel, channelName?: string) => {
    if (space.kind === 'self') {
      await createOwnedAgentSession();
      return;
    }

    if (space.kind === 'group') {
      if (!isNativeShell || !canonicalState || !account) {
        throw new Error('Sign in before creating a channel.');
      }
      const key = `channel:${space.id}:${channelName?.trim()}`;
      const sessionId = pendingCreateRef.current.get(key) ?? `session:group:${crypto.randomUUID()}`;
      pendingCreateRef.current.set(key, sessionId);
      await createGroupChannel({
        space, name: channelName ?? '', sessionId, canonicalState, account,
        sendCloudGroupControl, setCanonicalState, selectNewSession,
      });
      pendingCreateRef.current.delete(key);
      return;
    }

    const existingBlankSessionId = existingBlankSessionIdForParticipantSpace(space);
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
    account,
    sendCloudGroupControl,
    createOwnedAgentSession,
    isNativeShell,
    pendingCreateRef,
    selectNewSession,
    setCanonicalState,
    setDesktopError,
  ]);
}

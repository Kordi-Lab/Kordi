import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '@/features/cloud/cloudGroupControl.types';
import {
  cloudGroupParticipantsForCollaborationSession,
  cloudGroupSelfParticipant,
  cloudGroupTargetAccountIds,
} from '@/features/cloud/cloudGroupMessages';
import {
  buildChatGroupCollaborationUpdateParticipants,
  buildChatGroupCollaborationUpdateTargets,
} from '@/features/chat/chatCreateFlows';
import type { CanonicalSessionState } from '@/kordi-app/types';
import {
  addCanonicalSessionParticipants,
  removeCanonicalSessionParticipant,
  setCanonicalSessionParticipantRole,
  updateCanonicalSessionMetadata,
} from '@/lib/desktop';

import { canonicalGroupParticipantsForSessions } from './groupMembershipState';
import {
  activeGroupAdminIds,
  canonicalGroupCreatorIdentityId,
  canonicalGroupInviteTitleForSession,
  metadataGroupSpaceId,
  sessionMetadataRecord,
  uniqueStrings,
} from './useKordiAppModelHelpers';

type UseKordiGroupMemberRolesArgs = {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null;
  isNativeShell: boolean;
  sendCloudGroupControl: (
    input: SendCloudGroupControlInput,
  ) => Promise<void>;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
};

export function useKordiGroupMemberRoles({
  account,
  canonicalState,
  isNativeShell,
  sendCloudGroupControl,
  setCanonicalState,
  setDesktopError,
}: UseKordiGroupMemberRolesArgs) {
  const removeGroupMember = useCallback(async (
    sessionIds: string[],
    identityId: string,
  ) => {
    if (!isNativeShell) return;
    const currentState = canonicalState;
    if (!currentState) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const groupContextSessionIds = uniqueStrings(sessionIds).filter(
      (sessionId) => currentState.sessions.some(
        (session) => (
          session.id === sessionId
          && session.kind === 'group'
        ),
      ),
    );
    if (groupContextSessionIds.length === 0) return;
    const activeSessionIdsForIdentity = new Set(
      currentState.participants
        .filter(
          (participant) => (
            participant.identityId === identityId
            && participant.state === 'active'
          ),
        )
        .map((participant) => participant.sessionId),
    );
    const groupSessionIds = groupContextSessionIds.filter(
      (sessionId) => activeSessionIdsForIdentity.has(sessionId),
    );
    if (groupSessionIds.length === 0) return;
    setDesktopError(null);
    const actorIdentityId =
      currentState.profile.humanIdentityId?.trim();
    if (!actorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const fallbackGroupSpaceId = metadataGroupSpaceId(
      sessionMetadataRecord(currentState, groupContextSessionIds[0]),
    ) || groupContextSessionIds[0];
    const rootSessionId = currentState.sessions.some(
      (session) => session.id === fallbackGroupSpaceId,
    )
      ? fallbackGroupSpaceId
      : groupContextSessionIds[0];
    const previousParticipants = canonicalGroupParticipantsForSessions(
      currentState,
      groupContextSessionIds,
    );
    const previousTargets = buildChatGroupCollaborationUpdateTargets({
      actorIdentityId,
      participants: previousParticipants,
    });
    const targetAccountIds = cloudGroupTargetAccountIds(previousTargets);
    const removedIdentity = currentState.identities.find(
      (identity) => identity.id === identityId,
    );
    const removedAccountId =
      removedIdentity?.humanId?.trim()
      || removedIdentity?.sourceIdentityId?.trim()
      || '';
    const groupCreatorIdentityId = canonicalGroupCreatorIdentityId(
      currentState,
      rootSessionId,
    )
      || currentState.sessions.find(
        (session) => session.id === rootSessionId,
      )?.createdByIdentityId?.trim()
      || actorIdentityId;
    let nextState = currentState;
    for (const sessionId of groupSessionIds) {
      nextState = await removeCanonicalSessionParticipant({
        sessionId,
        identityId,
        removedByIdentityId: actorIdentityId,
      });
    }
    setCanonicalState(nextState);

    if (!account || !removedAccountId || targetAccountIds.length === 0) {
      return;
    }
    const participants = canonicalGroupParticipantsForSessions(
      nextState,
      groupContextSessionIds,
    );
    const adminIdentityIds = activeGroupAdminIds(
      nextState,
      rootSessionId,
    );
    const updateParticipants =
      buildChatGroupCollaborationUpdateParticipants({
        participants,
        adminIdentityIds,
      });
    const creatorIdentity = nextState.identities.find(
      (identity) => identity.id === groupCreatorIdentityId,
    );
    const createdByAccountId =
      creatorIdentity?.humanId?.trim()
      || creatorIdentity?.sourceIdentityId?.trim()
      || (
        groupCreatorIdentityId === nextState.profile.humanIdentityId
          ? account.accountId
          : ''
      );
    const removalEvent = {
      eventId: crypto.randomUUID(),
      accountId: removedAccountId,
      createdAtMs: Date.now(),
    };
    const actor = cloudGroupSelfParticipant(
      account,
      adminIdentityIds.includes(actorIdentityId) ? 'admin' : 'person',
    );
    try {
      await Promise.all(groupContextSessionIds.map((sessionId) => {
        const metadata = sessionMetadataRecord(nextState, sessionId);
        const groupSpaceId =
          metadataGroupSpaceId(metadata) || fallbackGroupSpaceId;
        return sendCloudGroupControl({
          targetAccountIds,
          kind: 'group-update',
          groupId: sessionId,
          groupSpaceId,
          groupTitle: canonicalGroupInviteTitleForSession(
            nextState,
            sessionId,
          ),
          createdByAccountId: createdByAccountId || null,
          actor,
          participants: cloudGroupParticipantsForCollaborationSession(
            account,
            updateParticipants,
          ),
          memberLeaves: [removalEvent],
        });
      }));
    } catch (error) {
      const message =
        `Group member removed locally, but Cloud sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      setDesktopError(message);
      throw new Error(message);
    }
  }, [
    account,
    canonicalState,
    isNativeShell,
    sendCloudGroupControl,
    setCanonicalState,
    setDesktopError,
  ]);

  const setGroupAdmin = useCallback(async (
    sessionIds: string[],
    identityId: string,
    isAdmin: boolean,
  ) => {
    if (!isNativeShell) return;
    if (!canonicalState) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const groupSessionIds = uniqueStrings(sessionIds).filter(
      (sessionId) => canonicalState.sessions.some(
        (session) => (
          session.id === sessionId
          && session.kind === 'group'
        ),
      ),
    );
    if (groupSessionIds.length === 0) return;
    setDesktopError(null);
    const actorIdentityId =
      canonicalState.profile.humanIdentityId?.trim();
    if (!actorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const firstSessionId = groupSessionIds[0];
    const fallbackGroupSpaceId = metadataGroupSpaceId(
      sessionMetadataRecord(canonicalState, firstSessionId),
    ) || firstSessionId;
    const rootSessionId = groupSessionIds.includes(fallbackGroupSpaceId)
      ? fallbackGroupSpaceId
      : firstSessionId;
    const groupCreatorIdentityId = canonicalGroupCreatorIdentityId(
      canonicalState,
      rootSessionId,
    )
      || canonicalState.sessions.find(
        (session) => session.id === rootSessionId,
      )?.createdByIdentityId?.trim()
      || actorIdentityId;
    if (actorIdentityId !== groupCreatorIdentityId) {
      throw new Error('Only the group creator can change group admins.');
    }
    if (!isAdmin && identityId === groupCreatorIdentityId) {
      throw new Error('The group creator must remain an admin.');
    }
    const currentAdminIds = uniqueStrings(
      activeGroupAdminIds(canonicalState, rootSessionId),
    );
    const nextAdminIds = isAdmin
      ? uniqueStrings([...currentAdminIds, identityId])
      : currentAdminIds.filter((adminId) => adminId !== identityId);
    const groupAdminUpdatedAtMs = Date.now();
    let nextState = canonicalState;
    for (const sessionId of groupSessionIds) {
      const targetIsActive = nextState.participants.some(
        (participant) => (
          participant.sessionId === sessionId
          && participant.identityId === identityId
          && participant.state === 'active'
        ),
      );
      if (!targetIsActive) {
        nextState = await addCanonicalSessionParticipants({
          sessionId,
          identityIds: [identityId],
          addedByIdentityId: actorIdentityId,
        });
      }
      nextState = await setCanonicalSessionParticipantRole({
        sessionId,
        identityId,
        role: isAdmin ? 'admin' : 'person',
        requestedByIdentityId: actorIdentityId,
      });
      const currentMetadata =
        sessionMetadataRecord(nextState, sessionId);
      nextState = await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId: actorIdentityId,
        metadata: {
          ...currentMetadata,
          groupId:
            metadataGroupSpaceId(currentMetadata)
            || fallbackGroupSpaceId,
          groupSpaceId:
            metadataGroupSpaceId(currentMetadata)
            || fallbackGroupSpaceId,
          groupCreatorIdentityId,
          adminIdentityIds: nextAdminIds,
          groupAdminUpdatedAtMs,
        },
      });
    }
    setCanonicalState(nextState);

    if (!account) return;
    const participants = canonicalGroupParticipantsForSessions(
      nextState,
      groupSessionIds,
    );
    const targets = buildChatGroupCollaborationUpdateTargets({
      actorIdentityId,
      participants,
    });
    const targetAccountIds = cloudGroupTargetAccountIds(targets);
    if (targetAccountIds.length === 0) return;
    const updateParticipants =
      buildChatGroupCollaborationUpdateParticipants({
        participants,
        adminIdentityIds: nextAdminIds,
      });
    const creatorIdentity = nextState.identities.find(
      (identity) => identity.id === groupCreatorIdentityId,
    );
    const createdByAccountId =
      creatorIdentity?.humanId?.trim()
      || creatorIdentity?.sourceIdentityId?.trim()
      || (
        groupCreatorIdentityId === nextState.profile.humanIdentityId
          ? account.accountId
          : ''
      );
    try {
      await sendCloudGroupControl({
        operationId:
          `group-admin:${rootSessionId}:${identityId}:${groupAdminUpdatedAtMs}`,
        targetAccountIds,
        kind: 'group-update',
        groupId: rootSessionId,
        groupSpaceId: fallbackGroupSpaceId,
        groupTitle: canonicalGroupInviteTitleForSession(
          nextState,
          rootSessionId,
        ),
        createdByAccountId: createdByAccountId || null,
        participants: cloudGroupParticipantsForCollaborationSession(
          account,
          updateParticipants,
        ),
      });
    } catch (error) {
      const message =
        `Group admin changed locally, but Cloud sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      setDesktopError(message);
      throw new Error(message);
    }
  }, [
    account,
    canonicalState,
    isNativeShell,
    sendCloudGroupControl,
    setCanonicalState,
    setDesktopError,
  ]);

  return {
    removeGroupMember,
    setGroupAdmin,
  };
}

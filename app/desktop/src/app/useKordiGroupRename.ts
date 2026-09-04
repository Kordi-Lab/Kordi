import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '@/features/cloud/cloudGroupControl.types';
import {
  cloudGroupParticipantsForCollaborationSession,
  cloudGroupTargetAccountIds,
} from '@/features/cloud/cloudGroupMessages';
import {
  buildChatGroupCollaborationUpdateParticipants,
  buildChatGroupCollaborationUpdateTargets,
} from '@/features/chat/chatCreateFlows';
import type { CanonicalSessionState } from '@/kordi-app/types';
import { updateCanonicalSessionMetadata } from '@/lib/desktop';

import { appendCanonicalRenameNotice } from './canonicalRenameNotice';
import {
  activeGroupAdminIds,
  canonicalGroupParticipantsForSession,
  groupRenameMetadata,
  metadataGroupSpaceId,
  sessionMetadataRecord,
  uniqueStrings,
} from './useKordiAppModelHelpers';

type UseKordiGroupRenameArgs = {
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

export function useKordiGroupRename({
  account,
  canonicalState,
  isNativeShell,
  sendCloudGroupControl,
  setCanonicalState,
  setDesktopError,
}: UseKordiGroupRenameArgs) {
  return useCallback(async (
    sessionIds: string[],
    name: string,
  ) => {
    if (!isNativeShell) return;
    const requestedSessionIds = uniqueStrings(sessionIds);
    if (requestedSessionIds.length === 0) return;
    const title = name.trim();
    if (!title) throw new Error('Group name is required.');
    setDesktopError(null);

    if (!canonicalState) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const actorIdentityId =
      canonicalState.profile.humanIdentityId?.trim();
    if (!actorIdentityId) {
      throw new Error('Local profile identity is not ready yet.');
    }

    const fallbackGroupSpaceId = requestedSessionIds[0];
    const requestedGroupIds = new Set(requestedSessionIds.map((sessionId) => (
      metadataGroupSpaceId(sessionMetadataRecord(canonicalState, sessionId))
        || fallbackGroupSpaceId
    )));
    const groupSessionIds = uniqueStrings([
      ...requestedSessionIds,
      ...canonicalState.sessions.flatMap((session) => {
        const metadata = sessionMetadataRecord(canonicalState, session.id);
        return session.kind === 'group'
          && requestedGroupIds.has(metadataGroupSpaceId(metadata) || session.id)
          ? [session.id]
          : [];
      }),
    ]);
    let nextState = canonicalState;
    const renamedSessionIdsByGroup = new Map<string, string[]>();
    for (const sessionId of groupSessionIds) {
      const currentMetadata =
        sessionMetadataRecord(nextState, sessionId);
      const groupId =
        metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId;
      nextState = await updateCanonicalSessionMetadata({
        sessionId,
        requestedByIdentityId: actorIdentityId,
        metadata: groupRenameMetadata(
          currentMetadata,
          title,
          groupId,
        ),
      });
      renamedSessionIdsByGroup.set(groupId, [
        ...(renamedSessionIdsByGroup.get(groupId) ?? []),
        sessionId,
      ]);
    }
    setCanonicalState(nextState);

    try {
      for (const [groupId, groupSessionIdsForGroup] of renamedSessionIdsByGroup) {
        const sourceSessionId = groupSessionIdsForGroup[0];
        if (!sourceSessionId) continue;
        const participants = canonicalGroupParticipantsForSession(
          nextState,
          sourceSessionId,
        );
        const targets = buildChatGroupCollaborationUpdateTargets({
          actorIdentityId,
          participants,
        });
        const updateParticipants =
          buildChatGroupCollaborationUpdateParticipants({
            participants,
            adminIdentityIds: activeGroupAdminIds(
              nextState,
              sourceSessionId,
            ),
          });
        const cloudTargetAccountIds =
          cloudGroupTargetAccountIds(targets);
        if (cloudTargetAccountIds.length > 0 && account) {
          for (const sessionId of groupSessionIdsForGroup) {
            await sendCloudGroupControl({
              targetAccountIds: cloudTargetAccountIds,
              kind: 'group-title-update',
              groupId: sessionId,
              groupSpaceId: groupId,
              groupTitle: title,
              participants: cloudGroupParticipantsForCollaborationSession(
                account,
                updateParticipants,
              ),
            });
          }
        } else {
          for (const sessionId of groupSessionIdsForGroup) {
            nextState = await appendCanonicalRenameNotice(
              nextState,
              sessionId,
              title,
              'group',
              actorIdentityId,
            );
          }
          setCanonicalState(nextState);
        }
      }
    } catch (error) {
      setDesktopError(
        `Group renamed, but hosted sync failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }, [
    account,
    canonicalState,
    isNativeShell,
    sendCloudGroupControl,
    setCanonicalState,
    setDesktopError,
  ]);
}

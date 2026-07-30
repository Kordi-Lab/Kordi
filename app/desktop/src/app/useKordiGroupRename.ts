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

import { appendCanonicalRenameNotice } from './useKordiChatSessionActions';
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
    const groupSessionIds = uniqueStrings(sessionIds);
    if (groupSessionIds.length === 0) return;
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

    const fallbackGroupSpaceId = groupSessionIds[0];
    let nextState = canonicalState;
    const renamedGroupIds = new Map<string, string>();
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
      renamedGroupIds.set(groupId, sessionId);
    }
    for (const sessionId of groupSessionIds) {
      nextState = await appendCanonicalRenameNotice(
        nextState,
        sessionId,
        title,
        'group',
        actorIdentityId,
      );
    }
    setCanonicalState(nextState);

    try {
      for (const [groupId, sourceSessionId] of renamedGroupIds) {
        const participants = canonicalGroupParticipantsForSession(
          nextState,
          sourceSessionId,
        );
        const targets = buildChatGroupCollaborationUpdateTargets({
          actorIdentityId,
          participants,
        });
        if (targets.length === 0) continue;
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
          await sendCloudGroupControl({
            targetAccountIds: cloudTargetAccountIds,
            kind: 'group-title-update',
            groupId,
            groupSpaceId: groupId,
            groupTitle: title,
            participants: cloudGroupParticipantsForCollaborationSession(
              account,
              updateParticipants,
            ),
          });
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

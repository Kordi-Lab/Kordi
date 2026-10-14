import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';

import { archiveDesktopChatSession } from '@/lib/desktop';

import type { CloudAuthClient } from './authClient';
import { CloudAuthError } from './cloudAuthError';

export type IdPresenceMutation = {
  valueRef: MutableRefObject<Set<string>>;
  setValue: Dispatch<SetStateAction<Set<string>>>;
  id: string;
  present: boolean;
};

export type VisibilityMutationRunner = (
  key: string,
  mutations: IdPresenceMutation[],
  commit: (token: string) => Promise<void>,
) => Promise<void>;

export async function setCloudGroupMuted({
  client,
  runMutation,
  mutedIdsRef,
  setMutedIds,
  groupSpaceId,
  sessionIds,
  muted,
}: {
  client: CloudAuthClient;
  runMutation: VisibilityMutationRunner;
  mutedIdsRef: MutableRefObject<Set<string>>;
  setMutedIds: Dispatch<SetStateAction<Set<string>>>;
  groupSpaceId: string;
  sessionIds: string[];
  muted: boolean;
}) {
  const id = groupSpaceId.trim();
  const sessions = [...new Set(sessionIds.map((value) => value.trim()).filter(Boolean))];
  if (!id || sessions.length === 0) return;
  await runMutation(
    `group-muted:${id}`,
    sessions.map((sessionId) => ({
      valueRef: mutedIdsRef, setValue: setMutedIds, id: sessionId, present: muted,
    })),
    (token) => client.setCloudGroupSpaceMuted(token, id, muted),
  );
}

/** The server has no member row for this account, so the group row is a stale local copy. */
function isNotAParticipantError(error: unknown) {
  return error instanceof CloudAuthError && error.status === 403 && error.code === 'not_a_participant';
}

async function archiveGroupSessionsLocally(sessionIds: string[]) {
  for (const sessionId of sessionIds) await archiveDesktopChatSession(sessionId);
}

export async function setCloudGroupArchived({
  client,
  runMutation,
  hiddenIdsRef,
  deletedIdsRef,
  pinnedIdsRef,
  pinnedGroupSpaceIdsRef,
  setHiddenIds,
  setDeletedIds,
  setPinnedIds,
  setPinnedGroupSpaceIds,
  groupSpaceId,
  sessionIds,
  archived,
  archiveLocally = archiveGroupSessionsLocally,
}: {
  client: CloudAuthClient;
  runMutation: VisibilityMutationRunner;
  hiddenIdsRef: MutableRefObject<Set<string>>;
  deletedIdsRef: MutableRefObject<Set<string>>;
  pinnedIdsRef: MutableRefObject<Set<string>>;
  pinnedGroupSpaceIdsRef: MutableRefObject<Set<string>>;
  setHiddenIds: Dispatch<SetStateAction<Set<string>>>;
  setDeletedIds: Dispatch<SetStateAction<Set<string>>>;
  setPinnedIds: Dispatch<SetStateAction<Set<string>>>;
  setPinnedGroupSpaceIds: Dispatch<SetStateAction<Set<string>>>;
  groupSpaceId: string;
  sessionIds: string[];
  archived: boolean;
  archiveLocally?: (sessionIds: string[]) => Promise<void>;
}) {
  const id = groupSpaceId.trim();
  const sessions = [...new Set(sessionIds.map((value) => value.trim()).filter(Boolean))];
  if (!id || sessions.length === 0) return;
  const mutations = sessions.flatMap((sessionId): IdPresenceMutation[] => [
    { valueRef: hiddenIdsRef, setValue: setHiddenIds, id: sessionId, present: archived },
    { valueRef: deletedIdsRef, setValue: setDeletedIds, id: sessionId, present: false },
    ...(archived ? [{ valueRef: pinnedIdsRef, setValue: setPinnedIds, id: sessionId, present: false }] : []),
  ]);
  if (archived) {
    mutations.push({
      valueRef: pinnedGroupSpaceIdsRef,
      setValue: setPinnedGroupSpaceIds,
      id,
      present: false,
    });
  }
  await runMutation(
    `group-archived:${id}`,
    mutations,
    async (token) => {
      try {
        await client.setCloudGroupSpaceArchived(token, id, archived);
      } catch (error) {
        if (!archived || !isNotAParticipantError(error)) throw error;
        // A group the server no longer lists for this account is archived on this Mac instead.
        await archiveLocally(sessions);
      }
    },
  );
}

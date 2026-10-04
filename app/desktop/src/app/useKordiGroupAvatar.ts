import { useCallback } from 'react';
import { defaultCloudAuthClient, type CloudAccount } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
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
import {
  activeGroupAdminIds,
  canonicalGroupParticipantsForSession,
  metadataGroupSpaceId,
  sessionMetadataRecord,
  uniqueStrings,
} from './useKordiAppModelHelpers';

export function useKordiGroupAvatar({ account, canonicalState, isNativeShell, sendCloudGroupControl }: {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null;
  isNativeShell: boolean;
  sendCloudGroupControl: (input: SendCloudGroupControlInput) => Promise<void>;
}) {
  return useCallback(async (sessionIds: string[], dataUrl: string | null) => {
    if (!isNativeShell || !canonicalState || !account) {
      throw new Error('Sign in before changing the group image.');
    }
    const ids = uniqueStrings(sessionIds);
    const actor = canonicalState.profile.humanIdentityId;
    if (!actor || !ids.length) throw new Error('This group is not ready yet.');
    const id = ids.find(candidate => activeGroupAdminIds(canonicalState, candidate).includes(actor));
    if (!id) {
      throw new Error('Only a group admin can change this image.');
    }
    const session = await loadSession();
    if (!session?.token) throw new Error('Sign in before changing the group image.');
    const imageUrl = dataUrl
      ? await defaultCloudAuthClient().uploadGroupAvatarAsset(session.token, dataUrl, account.accountId)
      : null;
    const groupAvatar = { imageUrl, updatedAtMs: Date.now() };
    const spaceId = metadataGroupSpaceId(sessionMetadataRecord(canonicalState, id)) || id;
    const participants = canonicalGroupParticipantsForSession(canonicalState, id);
    const targets = buildChatGroupCollaborationUpdateTargets({ actorIdentityId: actor, participants });
    // The server publishes one authoritative revision to every sibling channel.
    await sendCloudGroupControl({
      targetAccountIds: cloudGroupTargetAccountIds(targets),
      kind: 'group-avatar-update',
      groupId: id,
      groupSpaceId: spaceId,
      groupAvatar,
      participants: cloudGroupParticipantsForCollaborationSession(account,
        buildChatGroupCollaborationUpdateParticipants({
          participants, adminIdentityIds: activeGroupAdminIds(canonicalState, id),
        })),
    });
  }, [account, canonicalState, isNativeShell, sendCloudGroupControl]);
}

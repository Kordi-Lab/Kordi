import type { Dispatch, SetStateAction } from 'react';
import type { CloudAccount } from '@/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '@/features/cloud/cloudGroupControl.types';
import { cloudGroupParticipantsForCollaborationSession } from '@/features/cloud/cloudGroupMessages';
import { buildChatGroupCollaborationUpdateParticipants } from '@/features/chat/chatCreateFlows';
import type { CanonicalSessionState, ParticipantSpaceViewModel } from '@/kordi-app/types';
import { openOrCreateCanonicalSessionFast } from '@/lib/desktop';
import { mergeOpenCanonicalSessionResult } from './canonicalSessionStateMutations';
import { activeGroupAdminIds, canonicalGroupParticipantsForSession, metadataGroupSpaceId, sessionMetadataRecord } from './useKordiAppModelHelpers';

export async function createGroupChannel({ space, name, sessionId, canonicalState, account, sendCloudGroupControl, setCanonicalState, selectNewSession }: {
  space: ParticipantSpaceViewModel;
  name: string;
  sessionId: string;
  canonicalState: CanonicalSessionState;
  account: CloudAccount;
  sendCloudGroupControl: (input: SendCloudGroupControlInput) => Promise<void>;
  setCanonicalState: Dispatch<SetStateAction<CanonicalSessionState | null>>;
  selectNewSession: (id: string) => void;
}) {
  const title = name.trim();
  const creatorIdentityId = canonicalState.profile.humanIdentityId;
  if (!creatorIdentityId) throw new Error('Your profile is not ready yet. Try again.');
  if (!title || title.length > 200) throw new Error('Enter a channel name of 1–200 characters.');
  const source = space.sessions[0];
  const sourceId = source?.canonicalSessionId ?? source?.id;
  if (!sourceId) throw new Error('This group is not ready yet. Try again.');
  const sourceMetadata = { ...sessionMetadataRecord(canonicalState, sourceId) };
  delete sourceMetadata.cloudUnreadCount;
  delete sourceMetadata.titleSource;
  const groupSpaceId = metadataGroupSpaceId(sourceMetadata) || sourceId;
  const participants = canonicalGroupParticipantsForSession(canonicalState, sourceId);
  const cloudParticipants = cloudGroupParticipantsForCollaborationSession(account,
    buildChatGroupCollaborationUpdateParticipants({ participants, adminIdentityIds: activeGroupAdminIds(canonicalState, sourceId) }));
  const targetAccountIds = cloudParticipants.map((person) => person.accountId).filter((id) => id !== account.accountId);
  if (!targetAccountIds.length) throw new Error('Group members are not available yet. Try again.');
  const now = Date.now();
  await sendCloudGroupControl({
    kind: 'group-invite', groupId: sessionId, groupSpaceId,
    groupTitle: space.title, participants: cloudParticipants, targetAccountIds,
    channelCreated: true,
    sessionTitle: { title, titleSource: 'manual', titleRevision: 1, titlePolicyVersion: 1,
      updatedAtMs: now, updatedByAccountId: account.accountId },
  });
  const result = await openOrCreateCanonicalSessionFast({
    id: sessionId, kind: 'group', title, status: 'active',
    createdByIdentityId: creatorIdentityId,
    primaryIdentityId: null, relationshipIdentityId: null,
    participantIdentityIds: participants.map((person) => person.id),
    metadata: { ...sourceMetadata, groupId: groupSpaceId, groupSpaceId,
      continuedFromSessionId: sourceId, customName: space.title,
      sessionTitleSource: 'manual', sessionTitleRevision: 1, sessionTitleUpdatedAtMs: now,
      sessionTitleUpdatedByAccountId: account.accountId },
  });
  setCanonicalState((current) => mergeOpenCanonicalSessionResult(current ?? canonicalState, result));
  selectNewSession(sessionId);
}

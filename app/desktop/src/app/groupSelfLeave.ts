// Leaving a group as yourself on a server that supports it: tell the other
// members through group envelopes (naming a successor when the owner
// leaves), leave on the server once for the whole group, then update this
// device.

import {
  defaultCloudAuthClient,
  type CloudAccount,
  type CloudAuthClient,
} from '@/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '@/features/cloud/cloudGroupControl.types';
import {
  cloudGroupParticipantsForCollaborationSession,
  cloudGroupSelfParticipant,
} from '@/features/cloud/cloudGroupMessages';
import { loadSession } from '@/features/cloud/session';
import { buildChatGroupCollaborationUpdateParticipants } from '@/features/chat/chatCreateFlows';
import {
  chooseLeaveSuccessor,
  LEAVE_GROUP_ERROR,
  runGroupLeave,
  type LeaveSuccessorCandidate,
} from '@/features/safety/groupLeave';
import { leaveConversation, resolveCloudConversation } from '@/features/safety/safetyClient';
import { isServiceAccountId } from '@/features/safety/serviceAccounts';
import type { CanonicalSessionState, ConversationParticipant } from '@/kordi-app/types';
import { removeCanonicalSessionParticipant } from '@/lib/desktop';

import { canonicalGroupParticipantsForSessions } from './groupMembershipState';
import {
  activeGroupAdminIds,
  canonicalGroupInviteTitleForSession,
  metadataGroupSpaceId,
  sessionMetadataRecord,
  uniqueStrings,
} from './useKordiAppModelHelpers';

export type GroupSelfLeaveInput = {
  account: CloudAccount;
  state: CanonicalSessionState;
  actorIdentityId: string;
  /** Every channel of the group the leave was started from. */
  groupContextSessionIds: string[];
  /** The channels where this person is still an active participant. */
  groupSessionIds: string[];
  rootSessionId: string;
  fallbackGroupSpaceId: string;
  groupCreatorIdentityId: string;
  createdByAccountId: string;
  targetAccountIds: string[];
  sendCloudGroupControl: (input: SendCloudGroupControlInput) => Promise<void>;
  setCanonicalState: (state: CanonicalSessionState) => void;
  client?: CloudAuthClient;
};

function participantAccountId(participant: ConversationParticipant): string {
  return [participant.humanId, participant.sourceIdentityId]
    .map((value) => value?.trim() ?? '')
    .find((value) => value.startsWith('acct_')) ?? '';
}

export async function leaveGroupAsSelf(input: GroupSelfLeaveInput): Promise<'left' | 'envelope-only'> {
  const { account, state, actorIdentityId } = input;
  const session = await loadSession();
  if (!session?.token) throw new Error('Not signed in.');
  const token = session.token;
  const client = input.client ?? defaultCloudAuthClient();
  let rootConversation: Awaited<ReturnType<typeof resolveCloudConversation>>;
  try {
    rootConversation = await resolveCloudConversation(client, token, input.rootSessionId);
  } catch {
    throw new Error(LEAVE_GROUP_ERROR);
  }

  const participants = canonicalGroupParticipantsForSessions(state, input.groupContextSessionIds);
  const others = participants.filter((participant) => participant.id !== actorIdentityId);
  const candidates: LeaveSuccessorCandidate[] = others.flatMap((participant) => {
    const accountId = participantAccountId(participant);
    return participant.kind === 'human' && accountId && !isServiceAccountId(accountId)
      ? [{ identityId: participant.id, accountId, name: participant.name }]
      : [];
  });
  const adminIdentityIds = activeGroupAdminIds(state, input.rootSessionId);
  const serverRole = rootConversation?.members.find((member) => member.account_id === account.accountId)?.role;
  const isOwner = input.groupCreatorIdentityId === actorIdentityId || serverRole === 'owner';
  const successor = isOwner
    ? chooseLeaveSuccessor({ candidates, adminIdentityIds, serverMembers: rootConversation?.members })
    : null;
  // The envelope lists everyone but the leaver, with the successor as admin
  // so clients that apply envelope roles show them the admin controls.
  const updateParticipants = buildChatGroupCollaborationUpdateParticipants({
    participants: others,
    adminIdentityIds: uniqueStrings([
      ...adminIdentityIds.filter((identityId) => identityId !== actorIdentityId),
      ...(successor ? [successor.identityId] : []),
    ]),
  });
  const envelopeParticipants = cloudGroupParticipantsForCollaborationSession(account, updateParticipants)
    .filter((participant) => participant.accountId !== account.accountId);
  const leaveEvent = { eventId: globalThis.crypto.randomUUID(), accountId: account.accountId, createdAtMs: Date.now() };
  const actor = cloudGroupSelfParticipant(account, adminIdentityIds.includes(actorIdentityId) ? 'admin' : 'person');

  return runGroupLeave({
    isOwner,
    sendLeaveEnvelopes: () => Promise.all(input.groupContextSessionIds.map((sessionId) => input.sendCloudGroupControl({
      targetAccountIds: input.targetAccountIds,
      kind: 'group-update',
      groupId: sessionId,
      groupSpaceId: metadataGroupSpaceId(sessionMetadataRecord(state, sessionId)) || input.fallbackGroupSpaceId,
      groupTitle: canonicalGroupInviteTitleForSession(state, sessionId),
      createdByAccountId: input.createdByAccountId || null,
      actor,
      participants: envelopeParticipants,
      memberLeaves: [leaveEvent],
    }))),
    leaveOnServer: async () => {
      if (rootConversation) await leaveConversation(client, token, rootConversation.id, successor?.accountId ?? null);
    },
    removeLocally: async () => {
      let next = state;
      for (const sessionId of input.groupSessionIds) {
        next = await removeCanonicalSessionParticipant({
          sessionId,
          identityId: actorIdentityId,
          removedByIdentityId: actorIdentityId,
        });
      }
      input.setCanonicalState(next);
    },
  });
}

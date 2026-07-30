import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '@/features/cloud/cloudGroupControl.types';
import {
  cloudGroupParticipantFromContact,
  cloudGroupParticipantsForCollaborationSession,
  cloudGroupTargetAccountIds,
} from '@/features/cloud/cloudGroupMessages';
import {
  buildChatCreateGroupCollaborationInviteTargets,
  contactCanonicalIdentityRequest,
  isApprovedCollaborationContact,
} from '@/features/chat/chatCreateFlows';
import type {
  CanonicalGroupMembershipDelta,
  CanonicalIdentity,
  CanonicalSessionState,
  Contact,
} from '@/kordi-app/types';
import {
  addCanonicalGroupMembersFast,
  upsertCanonicalIdentityFast,
} from '@/lib/desktop';

import {
  canonicalGroupInviteContextForSession,
  canonicalGroupCreatorIdentityId,
  metadataGroupSpaceId,
  metadataStringArray,
  sessionMetadataRecord,
  uniqueStrings,
} from './useKordiAppModelHelpers';
import { mergeCanonicalIdentity } from './canonicalSessionStateMutations';
import {
  mergeCanonicalGroupMembershipDelta,
  stageCanonicalGroupMembership,
} from './groupMembershipState';

type UseKordiGroupMemberInvitesArgs = {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null;
  contactById: ReadonlyMap<string, Contact>;
  isNativeShell: boolean;
  sendCloudGroupControl: (
    input: SendCloudGroupControlInput,
  ) => Promise<void>;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
};

export function useKordiGroupMemberInvites({
  account,
  canonicalState,
  contactById,
  isNativeShell,
  sendCloudGroupControl,
  setCanonicalState,
  setDesktopError,
}: UseKordiGroupMemberInvitesArgs) {
  const addGroupMembers = useCallback(async (
    sessionIds: string[],
    contactIds: string[],
  ) => {
    if (!isNativeShell) return;
    const groupSessionIds = uniqueStrings(sessionIds);
    if (groupSessionIds.length === 0) return;
    setDesktopError(null);
    const creatorIdentityId =
      canonicalState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId || !canonicalState) {
      throw new Error('Local profile identity is not ready yet.');
    }
    const contacts = uniqueStrings(contactIds)
      .map((contactId) => contactById.get(contactId))
      .filter((contact): contact is Contact => Boolean(contact));
    const blockedCollaborationContacts = contacts.filter(
      (contact) => (
        contact.sourceParticipantId
        && !isApprovedCollaborationContact(contact)
      ),
    );
    if (blockedCollaborationContacts.length > 0) {
      throw new Error(
        'Approve people as contacts before adding them to a group.',
      );
    }

    const identityIds: string[] = [];
    const invitedMemberByIdentityId = new Map<
      string,
      { contact: Contact; displayName: string }
    >();
    const upsertedIdentities: CanonicalIdentity[] = [];
    let nextState = canonicalState;
    for (const contact of contacts) {
      const identityRequest = contactCanonicalIdentityRequest(contact);
      const identityId = identityRequest.id?.trim();
      if (!identityId) continue;
      const identity = await upsertCanonicalIdentityFast(identityRequest);
      upsertedIdentities.push(identity);
      nextState = mergeCanonicalIdentity(nextState, identity);
      identityIds.push(identityId);
      invitedMemberByIdentityId.set(identityId, {
        contact,
        displayName:
          identity.displayName.trim() || contact.name.trim() || 'Someone',
      });
    }
    const participantIdentityIds = uniqueStrings(identityIds);
    if (participantIdentityIds.length === 0) return;
    const joinEventStartedAtMs = Date.now();
    const joinEvents = participantIdentityIds.map(
      (memberIdentityId, index) => {
        const invitedMember =
          invitedMemberByIdentityId.get(memberIdentityId);
        const cloudParticipant = invitedMember
          ? cloudGroupParticipantFromContact(invitedMember.contact)
          : null;
        return {
          eventId: crypto.randomUUID(),
          memberIdentityId,
          displayName: invitedMember?.displayName ?? 'Someone',
          cloudParticipant,
          createdAtMs: joinEventStartedAtMs + index,
        };
      },
    );
    const cloudMemberJoins = joinEvents.flatMap((event) => (
      event.cloudParticipant
        ? [{
            eventId: event.eventId,
            accountId: event.cloudParticipant.accountId,
            displayName: event.displayName,
            createdAtMs: event.createdAtMs,
          }]
        : []
    ));

    const fallbackGroupSpaceId = groupSessionIds[0];
    const addedContactIds = contacts.map((contact) => contact.id);
    const addedNames = contacts.map((contact) => contact.name);
    const membershipUpdates = groupSessionIds.map((sessionId) => {
      const currentMetadata = sessionMetadataRecord(nextState, sessionId);
      return {
        sessionId,
        groupSpaceId:
          metadataGroupSpaceId(currentMetadata) || fallbackGroupSpaceId,
        addedContactIds,
        addedParticipantNames: addedNames,
      };
    });
    const membershipSessions = membershipUpdates.map((update) => {
      const currentMetadata =
        sessionMetadataRecord(nextState, update.sessionId);
      return {
        sessionId: update.sessionId,
        metadata: {
          ...currentMetadata,
          groupId: update.groupSpaceId,
          groupSpaceId: update.groupSpaceId,
          initialContactIds: uniqueStrings([
            ...metadataStringArray(currentMetadata, 'initialContactIds'),
            ...update.addedContactIds,
          ]),
          initialParticipantNames: uniqueStrings([
            ...metadataStringArray(
              currentMetadata,
              'initialParticipantNames',
            ),
            ...update.addedParticipantNames,
          ]),
        },
      };
    });
    const stagedState = stageCanonicalGroupMembership(
      nextState,
      membershipSessions,
      participantIdentityIds,
      creatorIdentityId,
    );

    const inviteTargets =
      buildChatCreateGroupCollaborationInviteTargets(contacts);
    const cloudInviteTargetAccountIds =
      cloudGroupTargetAccountIds(inviteTargets);
    if (cloudInviteTargetAccountIds.length > 0 && !account) {
      const message = 'Could not add Cloud group members while signed out.';
      setDesktopError(message);
      throw new Error(message);
    }
    if (cloudInviteTargetAccountIds.length > 0 && account) {
      await publishCloudGroupInvites({
        account,
        cloudInviteTargetAccountIds,
        cloudMemberJoins,
        creatorIdentityId,
        fallbackGroupSpaceId,
        groupSessionIds,
        sendCloudGroupControl,
        setDesktopError,
        stagedState,
      });
    }

    let membershipDelta: CanonicalGroupMembershipDelta;
    try {
      membershipDelta = await addCanonicalGroupMembersFast({
        sessions: membershipUpdates,
        identityIds: participantIdentityIds,
        addedByIdentityId: creatorIdentityId,
        joinEvents: joinEvents.map(({
          eventId,
          memberIdentityId,
          createdAtMs,
        }) => ({
          eventId,
          memberIdentityId,
          createdAtMs,
        })),
      });
    } catch (error) {
      const message =
        `Kordi could not save the group members locally: ${
          error instanceof Error ? error.message : String(error)
        }`;
      setDesktopError(message);
      throw new Error(message);
    }
    setCanonicalState((current) => {
      let mergedState = current ?? nextState;
      for (const identity of upsertedIdentities) {
        mergedState = mergeCanonicalIdentity(mergedState, identity);
      }
      return mergeCanonicalGroupMembershipDelta(
        mergedState,
        membershipDelta,
      );
    });
  }, [
    account,
    canonicalState,
    contactById,
    isNativeShell,
    sendCloudGroupControl,
    setCanonicalState,
    setDesktopError,
  ]);

  return addGroupMembers;
}

async function publishCloudGroupInvites({
  account,
  cloudInviteTargetAccountIds,
  cloudMemberJoins,
  creatorIdentityId,
  fallbackGroupSpaceId,
  groupSessionIds,
  sendCloudGroupControl,
  setDesktopError,
  stagedState,
}: {
  account: CloudAccount;
  cloudInviteTargetAccountIds: string[];
  cloudMemberJoins: Array<{
    eventId: string;
    accountId: string;
    displayName: string;
    createdAtMs: number;
  }>;
  creatorIdentityId: string;
  fallbackGroupSpaceId: string;
  groupSessionIds: string[];
  sendCloudGroupControl: (
    input: SendCloudGroupControlInput,
  ) => Promise<void>;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
  stagedState: CanonicalSessionState;
}) {
  try {
    const groupCreatorIdentityId =
      canonicalGroupCreatorIdentityId(stagedState, groupSessionIds[0])
      || creatorIdentityId;
    const groupCreatorIdentity = stagedState.identities.find(
      (identity) => identity.id === groupCreatorIdentityId,
    );
    const groupCreatorAccountId =
      groupCreatorIdentity?.humanId?.trim()
      || groupCreatorIdentity?.sourceIdentityId?.trim()
      || (
        groupCreatorIdentityId === stagedState.profile.humanIdentityId
          ? account.accountId
          : ''
      );
    await Promise.all(groupSessionIds.map(async (sessionId) => {
      const inviteContext = canonicalGroupInviteContextForSession(
        stagedState,
        sessionId,
        fallbackGroupSpaceId,
      );
      await sendCloudGroupControl({
        targetAccountIds: cloudInviteTargetAccountIds,
        kind: 'group-invite',
        groupId: sessionId,
        groupSpaceId: inviteContext.parentGroupSpaceId || sessionId,
        groupTitle: inviteContext.parentSessionTitle,
        createdByAccountId: groupCreatorAccountId || null,
        participants: cloudGroupParticipantsForCollaborationSession(
          account,
          inviteContext.parentSessionParticipants,
        ),
        memberJoins: cloudMemberJoins,
      });
    }));
  } catch (error) {
    const message =
      `Could not add group members because the Cloud invite failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    setDesktopError(message);
    throw new Error(message);
  }
}

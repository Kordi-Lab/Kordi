import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';
import type { SendCloudGroupControlInput } from '@/features/cloud/cloudGroupControl.types';
import {
  cloudGroupIdentityRequest,
  cloudGroupParticipantsForContacts,
  cloudGroupSelfParticipant,
  cloudGroupTargetAccountIds,
} from '@/features/cloud/cloudGroupMessages';
import {
  buildChatCreateGroupCollaborationInviteTargets,
  buildChatCreateGroupMetadata,
  contactCanonicalIdentityRequest,
  groupDefaultName,
  isApprovedCollaborationContact,
} from '@/features/chat/chatCreateFlows';
import type {
  CanonicalSessionState,
  Contact,
} from '@/kordi-app/types';
import {
  openOrCreateCanonicalSessionFast,
  upsertCanonicalIdentityFast,
} from '@/lib/desktop';

import {
  mergeCanonicalIdentity,
  mergeOpenCanonicalSessionResult,
} from './canonicalSessionStateMutations';
import { uniqueStrings } from './useKordiAppModelHelpers';

type UseKordiGroupCreationArgs = {
  account: CloudAccount | null;
  canonicalState: CanonicalSessionState | null;
  contactById: ReadonlyMap<string, Contact>;
  isNativeShell: boolean;
  selectNewSession: (sessionId: string) => void;
  sendCloudGroupControl: (
    input: SendCloudGroupControlInput,
  ) => Promise<void>;
  setCanonicalState: Dispatch<
    SetStateAction<CanonicalSessionState | null>
  >;
  setDesktopError: Dispatch<SetStateAction<string | null>>;
};

export function useKordiGroupCreation({
  account,
  canonicalState,
  contactById,
  isNativeShell,
  selectNewSession,
  sendCloudGroupControl,
  setCanonicalState,
  setDesktopError,
}: UseKordiGroupCreationArgs) {
  return useCallback(async (request: {
    name?: string | null;
    contactIds: string[];
  }) => {
    if (!isNativeShell) return;
    setDesktopError(null);
    const creatorIdentityId =
      canonicalState?.profile.humanIdentityId?.trim();
    if (!creatorIdentityId || !canonicalState) {
      throw new Error('Local profile identity is not ready yet.');
    }
    let nextCanonicalState = canonicalState;
    if (account) {
      const identity = await upsertCanonicalIdentityFast(
        cloudGroupIdentityRequest(
          cloudGroupSelfParticipant(account, 'admin'),
          account,
          creatorIdentityId,
        ),
      );
      nextCanonicalState = mergeCanonicalIdentity(
        nextCanonicalState,
        identity,
      );
      setCanonicalState(nextCanonicalState);
    }
    const contacts = uniqueStrings(request.contactIds)
      .map((contactId) => contactById.get(contactId))
      .filter((contact): contact is Contact => Boolean(contact));
    if (contacts.length < 2) {
      throw new Error('Select at least 2 people to start a group.');
    }
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
    for (const contact of contacts) {
      const identityRequest = contactCanonicalIdentityRequest(contact);
      const identityId = identityRequest.id?.trim();
      if (!identityId) continue;
      const identity = await upsertCanonicalIdentityFast(identityRequest);
      nextCanonicalState = mergeCanonicalIdentity(
        nextCanonicalState,
        identity,
      );
      setCanonicalState(nextCanonicalState);
      identityIds.push(identityId);
    }

    const participantIdentityIds = uniqueStrings(identityIds);
    if (participantIdentityIds.length < 2) {
      throw new Error('Select at least 2 people to start a group.');
    }
    const selectedNames = contacts.map((contact) => contact.name);
    const groupDisplayName =
      request.name?.trim() || groupDefaultName(selectedNames);
    const sessionId = `session:group:${crypto.randomUUID()}`;
    const openResult = await openOrCreateCanonicalSessionFast({
      id: sessionId,
      kind: 'group',
      title: 'New session',
      status: 'active',
      createdByIdentityId: creatorIdentityId,
      primaryIdentityId: null,
      relationshipIdentityId: null,
      participantIdentityIds,
      metadata: buildChatCreateGroupMetadata({
        creatorIdentityId,
        selectedContactIds: contacts.map((contact) => contact.id),
        selectedNames,
        customName: groupDisplayName,
        groupSpaceId: sessionId,
      }),
    });
    nextCanonicalState = mergeOpenCanonicalSessionResult(
      nextCanonicalState,
      openResult,
    );
    setCanonicalState(nextCanonicalState);

    const inviteTargets =
      buildChatCreateGroupCollaborationInviteTargets(contacts);
    const cloudInviteTargetAccountIds =
      cloudGroupTargetAccountIds(inviteTargets);
    if (cloudInviteTargetAccountIds.length > 0 && account) {
      try {
        await sendCloudGroupControl({
          targetAccountIds: cloudInviteTargetAccountIds,
          kind: 'group-invite',
          groupId: sessionId,
          groupSpaceId: sessionId,
          groupTitle: groupDisplayName,
          createdByAccountId: account.accountId,
          participants: cloudGroupParticipantsForContacts(
            account,
            contacts,
          ),
        });
      } catch (error) {
        setDesktopError(
          `Group created, but Cloud invites failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    selectNewSession(sessionId);
  }, [
    account,
    canonicalState,
    contactById,
    isNativeShell,
    selectNewSession,
    sendCloudGroupControl,
    setCanonicalState,
    setDesktopError,
  ]);
}

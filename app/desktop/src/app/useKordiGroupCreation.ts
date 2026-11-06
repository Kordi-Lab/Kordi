import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { defaultCloudAuthClient } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
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
  isApprovedCollaborationContact,
} from '@/features/chat/chatCreateFlows';
import { groupCreationErrorMessage } from '@/features/chat/groupCreateCopy';
import type {
  CanonicalSessionState,
  Contact,
} from '@/kordi-app/types';
import {
  deleteDesktopChatSessionForever,
  openOrCreateCanonicalSessionFast,
  upsertCanonicalIdentityFast,
} from '@/lib/desktop';

import {
  mergeCanonicalIdentity,
  mergeOpenCanonicalSessionResult,
} from './canonicalSessionStateMutations';
import { removeSessionFromCanonicalState, uniqueStrings } from './useKordiAppModelHelpers';
import { rememberSessionOrganization } from '@/features/organizations/sessionOrganization';

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
  const rollBackGroup = useCallback(async (sessionId: string, previousState: CanonicalSessionState) => {
    setCanonicalState((current) => removeSessionFromCanonicalState(current ?? previousState, sessionId));
    await deleteDesktopChatSessionForever(sessionId).catch(() => undefined);
    const login = await loadSession().catch(() => null);
    if (login?.token) {
      await defaultCloudAuthClient().dissolveGroup(login.token, sessionId).catch(() => undefined);
    }
  }, [setCanonicalState]);

  return useCallback(async (request: {
    avatarDataUrl?: string | null;
    name?: string | null;
    contactIds: string[];
    inviteLink?: boolean;
  }): Promise<string | undefined> => {
    if (!isNativeShell) return undefined;
    const groupDisplayName = request.name?.trim() ?? '';
    if (!groupDisplayName) throw new Error('Enter a group name.');
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
    const selectedNames = contacts.map((contact) => contact.name);
    const login = request.avatarDataUrl ? await loadSession() : null;
    if (request.avatarDataUrl && (!login?.token || !account)) throw new Error('Sign in before setting a group image.');
    const groupAvatar = request.avatarDataUrl && login?.token && account
      ? { imageUrl: await defaultCloudAuthClient().uploadGroupAvatarAsset(login.token, request.avatarDataUrl, account.accountId), updatedAtMs: Date.now() } : null;
    const sessionId = `session:group:${crypto.randomUUID()}`;
    const createdAtMs = Date.now();
    const openResult = await openOrCreateCanonicalSessionFast({
      id: sessionId,
      kind: 'group',
      title: 'New session',
      status: 'active',
      createdByIdentityId: creatorIdentityId,
      primaryIdentityId: null,
      relationshipIdentityId: null,
      participantIdentityIds,
      metadata: { ...buildChatCreateGroupMetadata({
        creatorIdentityId,
        selectedContactIds: contacts.map((contact) => contact.id),
        selectedNames,
        customName: groupDisplayName,
        groupSpaceId: sessionId,
      }), ...(groupAvatar ? { groupAvatar } : {}) },
    });
    rememberSessionOrganization(sessionId, account?.accountId);
    const stateBeforeGroup = nextCanonicalState;
    nextCanonicalState = mergeOpenCanonicalSessionResult(
      nextCanonicalState,
      openResult,
    );
    // A new group goes to the top of Chats before its first message arrives.
    nextCanonicalState = withSessionActivityAt(nextCanonicalState, sessionId, createdAtMs);
    setCanonicalState(nextCanonicalState);

    const inviteTargets =
      buildChatCreateGroupCollaborationInviteTargets(contacts);
    const cloudInviteTargetAccountIds =
      cloudGroupTargetAccountIds(inviteTargets);
    // A group may start with only its creator. Its invite still goes to the
    // server, addressed to the creator, so the group exists there and can
    // share an invitation link.
    if (account && (cloudInviteTargetAccountIds.length > 0 || contacts.length === 0)) {
      try {
        await sendCloudGroupControl({
          targetAccountIds: cloudInviteTargetAccountIds,
          kind: 'group-invite',
          groupId: sessionId,
          groupSpaceId: sessionId,
          groupTitle: groupDisplayName,
          groupAvatar,
          createdByAccountId: account.accountId,
          participants: cloudGroupParticipantsForContacts(
            account,
            contacts,
          ),
          transient: true,
        });
      } catch (error) {
        // Never leave a half-created group behind: undo the local group, and
        // the server group if its conversation was made before the failure.
        await rollBackGroup(sessionId, stateBeforeGroup);
        throw new Error(groupCreationErrorMessage(error));
      }
    }

    selectNewSession(sessionId);
    return sessionId;
  }, [
    account,
    canonicalState,
    contactById,
    isNativeShell,
    rollBackGroup,
    selectNewSession,
    sendCloudGroupControl,
    setCanonicalState,
    setDesktopError,
  ]);
}

/** Marks a session's last activity, so the Chats list orders it by that time. */
export function withSessionActivityAt(
  state: CanonicalSessionState,
  sessionId: string,
  atMs: number,
): CanonicalSessionState {
  return {
    ...state,
    sessions: state.sessions.map((session) => (
      session.id === sessionId && (session.lastMessageAtMs ?? 0) < atMs
        ? { ...session, lastMessageAtMs: atMs }
        : session
    )),
  };
}

import {
  groupMetadataWithoutSessionTitleOwnership,
  resolveReplicatedGroupTitle,
} from '@/features/chat/groupTitle';
import {
  appendCanonicalMessage,
  openOrCreateCanonicalSessionFast,
  removeCanonicalSessionParticipant,
  upsertCanonicalIdentityFast,
  upsertCanonicalMessageFast,
} from '@/lib/desktop';
import type {
  CanonicalIdentity,
  CanonicalSessionState,
  OpenCanonicalSessionFastResult,
} from '@/kordi-app/types';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import type { CloudPublicProfile } from './authClient';
import { canonicalAvatarImageSource } from './canonicalAvatar';
import {
  cloudGroupIdentityRequest,
  cloudGroupMemberJoinNoticeRequests,
  cloudGroupParticipantsWithProfiles,
  cloudGroupSelfParticipant,
  cloudGroupTitleUpdateNoticeRequest,
  cloudSessionTitleUpdateNoticeRequest,
  cloudSessionTitleUpdateTitle,
  shouldApplyCloudGroupTitleUpdate,
  type CloudGroupControlEnvelope,
  type CloudGroupSessionTitleSnapshot,
} from './cloudGroupMessages';
import {
  cloudGroupSessionPreparationSignature,
} from './cloudGroupSessionPolicy';
import { compareCloudGroupParticipants } from './cloudGroupParticipantTypes';
import { loadSession } from './session';
import type {
  CloudGroupCanonicalRuntime,
  CloudGroupControlContext,
  CloudGroupSessionRuntime,
} from './cloudGroupControlContext';

type CloudGroupSessionStateOps = {
  objectContent(value: unknown): Record<string, unknown>;
  cleanText(value?: string | null): string;
  resolveAdminSnapshot(input: {
    envelope: Pick<CloudGroupControlEnvelope, 'kind' | 'actor' | 'participants' | 'createdByAccountId'>;
    identityIdByAccount: ReadonlyMap<string, string>;
    createdByIdentityId: string;
    existingAdminIdentityIds: string[];
    hasExistingSession: boolean;
    controlCreatedAtMs: number;
    storedAdminUpdatedAtMs: number;
  }): { applies: boolean; adminIdentityIds: string[] };
  resolveSessionTitle(input: {
    envelope: Pick<CloudGroupControlEnvelope, 'kind' | 'groupTitle' | 'actor' | 'sessionTitle'>;
    controlCreatedAtMs: number;
    identityIdByAccount: ReadonlyMap<string, string>;
    adminIdentityIds: readonly string[];
  }): CloudGroupSessionTitleSnapshot | null;
  upsertIdentity(
    current: CanonicalSessionState | null,
    identity: CanonicalIdentity,
  ): CanonicalSessionState | null;
  mergeOpenSession(
    current: CanonicalSessionState | null,
    result: OpenCanonicalSessionFastResult,
  ): CanonicalSessionState | null;
};

export type ApplyCloudGroupSessionControlInput = {
  cloudMessage: CloudGroupControlContext['cloudMessage'];
  envelope: CloudGroupControlEnvelope;
  historyReplay?: boolean;
  runtime: CloudGroupSessionRuntime;
  canonical: CloudGroupCanonicalRuntime;
  stateOps: CloudGroupSessionStateOps;
};

export function cloudGroupHistoryReplayPreservesSessionShell(
  historyReplay: boolean | undefined,
  hasExistingSession: boolean,
) {
  return historyReplay === true && hasExistingSession;
}

export async function applyCloudGroupSessionControl({
  cloudMessage,
  envelope,
  historyReplay,
  runtime,
  canonical,
  stateOps,
}: ApplyCloudGroupSessionControlInput): Promise<CloudGroupControlContext | null> {
  const { account, client, profileCache } = runtime;
  const canonicalState = canonical.getState();
  if (!account || !canonicalState || !canonical.setState) return null;
  const localHumanIdentityId = canonicalState.profile.humanIdentityId?.trim();
  if (!localHumanIdentityId) return null;
  if (envelope.kind !== 'group-message') {
    runtime.sessionPreparationCache.delete(envelope.groupId);
  }
  const preparationSignature = cloudGroupSessionPreparationSignature(envelope, account);
  const cachedPreparation = runtime.sessionPreparationCache.get(envelope.groupId);
  if (
    envelope.kind === 'group-message'
    && cachedPreparation?.signature === preparationSignature
    && cachedPreparation.localHumanIdentityId === localHumanIdentityId
    && canonicalState.sessions.some((session) => session.id === envelope.groupId)
  ) {
    return {
      account,
      cloudMessage,
      envelope,
      canonicalState,
      nextState: canonicalState,
      localHumanIdentityId,
      groupSpaceId: cachedPreparation.groupSpaceId,
      participantByAccount: cachedPreparation.participantByAccount,
      identityIdByAccount: cachedPreparation.identityIdByAccount,
    };
  }

  const rawParticipants = [envelope.actor, ...envelope.participants, cloudGroupSelfParticipant(account, 'self')];
  const profileAccountIds = [...new Set(
    rawParticipants.map((participant) => participant.accountId.trim()).filter(Boolean),
  )];
  const missingProfileAccountIds = profileAccountIds.filter((accountId) => !profileCache.has(accountId));
  if (missingProfileAccountIds.length > 0) {
    const session = await loadSession();
    if (session?.token) {
      await Promise.all(missingProfileAccountIds.map(async (accountId) => {
        try {
          const profile = accountId === account.accountId
            ? {
                accountId: account.accountId,
                kordiId: account.kordiId,
                displayName: account.displayName,
                avatarUrl: canonicalAvatarImageSource(account.avatar),
                nodeId: account.nodeId,
                isContact: false,
                isSelf: true,
              }
            : await client.getProfile(session.token, accountId);
          profileCache.set(accountId, profile);
        } catch {
          // Group sync must still work if a profile lookup races account/session refresh.
        }
      }));
    }
  }
  const hydratedParticipants = cloudGroupParticipantsWithProfiles(
    rawParticipants,
    profileAccountIds
      .map((accountId) => profileCache.get(accountId))
      .filter((profile): profile is CloudPublicProfile => Boolean(profile)),
  );
  const participantByAccount = new Map<string, (typeof hydratedParticipants)[number]>();
  for (const participant of hydratedParticipants) {
    const accountId = participant.accountId;
    if (!accountId.trim() || participantByAccount.has(accountId)) continue;
    participantByAccount.set(accountId, participant);
  }

  const identityIdByAccount = new Map<string, string>();
  let nextState: CanonicalSessionState | null = canonicalState;
  for (const participant of participantByAccount.values()) {
    const request = cloudGroupIdentityRequest(participant, account, localHumanIdentityId);
    identityIdByAccount.set(participant.accountId, request.id ?? '');
    const identity = await upsertCanonicalIdentityFast(request);
    nextState = stateOps.upsertIdentity(nextState, identity);
  }
  if (!nextState) return null;

  const groupSpaceId = envelope.groupSpaceId?.trim() || envelope.groupId;
  const envelopeSession = canonicalState.sessions.find((session) => session.id === envelope.groupId) ?? null;
  if (cloudGroupHistoryReplayPreservesSessionShell(historyReplay, Boolean(envelopeSession))) {
    const actorIdentityId = identityIdByAccount.get(envelope.actor.accountId)
      ?? envelopeSession!.createdByIdentityId;
    for (const noticeRequest of cloudGroupMemberJoinNoticeRequests({
      envelope,
      actorIdentityId,
      identityIdByAccount,
      existingMessageIds: new Set(nextState.messages.map((message) => message.id)),
    })) {
      await upsertCanonicalMessageFast(noticeRequest);
    }
    if (envelope.kind !== 'group-message' || !envelope.message) {
      canonical.setState(nextState);
      return null;
    }
    return {
      account,
      cloudMessage,
      envelope,
      canonicalState,
      nextState,
      localHumanIdentityId,
      groupSpaceId,
      participantByAccount,
      identityIdByAccount,
    };
  }
  const groupRootSession = canonicalState.sessions.find((session) => session.id === groupSpaceId) ?? null;
  const envelopeSessionMetadata = stateOps.objectContent(envelopeSession?.metadata);
  const groupRootMetadata = stateOps.objectContent(groupRootSession?.metadata);
  const inheritedGroupRootMetadata = groupMetadataWithoutSessionTitleOwnership(groupRootMetadata);
  const storedCreatorIdentityId = stateOps.cleanText(
    typeof envelopeSessionMetadata.groupCreatorIdentityId === 'string'
      ? envelopeSessionMetadata.groupCreatorIdentityId
      : typeof groupRootMetadata.groupCreatorIdentityId === 'string'
        ? groupRootMetadata.groupCreatorIdentityId
        : groupRootSession?.createdByIdentityId || envelopeSession?.createdByIdentityId || null,
  );
  const createdByIdentityId = storedCreatorIdentityId
    || identityIdByAccount.get(envelope.createdByAccountId)
    || identityIdByAccount.get(envelope.actor.accountId)
    || localHumanIdentityId;
  const participantIdentityIds = [...identityIdByAccount.entries()]
    .filter(([, identityId]) => identityId !== createdByIdentityId)
    .map(([, identityId]) => identityId);
  const sessionTitleUpdateTitle = cloudSessionTitleUpdateTitle(envelope);
  const incomingGroupTitle = shouldApplyCloudGroupTitleUpdate(envelope) ? envelope.groupTitle : null;
  const isSelfAuthoredControl = envelope.actor.accountId === account.accountId;
  const participantNames = [...participantByAccount.values()].map((participant) => participant.displayName);
  const forkMetadata = envelope.fork ? {
    forkedFromSessionId: envelope.fork.parentSessionId,
    forkedFromMessageId: envelope.fork.parentMessageId ?? null,
    forkMode: 'cloud-group',
    contextPolicy: 'prefix-through-message',
    boundary: 'inherited-history-reference-only',
    createdAtMs: envelope.fork.createdAtMs ?? null,
  } : null;
  const parsedControlCreatedAtMs = Date.parse(cloudMessage.createdAt);
  const controlCreatedAtMs = Number.isFinite(parsedControlCreatedAtMs) ? parsedControlCreatedAtMs : Date.now();
  const groupTitleResolution = resolveReplicatedGroupTitle({
    candidates: [
      { sessionId: groupSpaceId, metadata: groupRootMetadata },
      { sessionId: envelope.groupId, metadata: envelopeSessionMetadata },
    ].map(({ sessionId, metadata }) => ({
      sessionId,
      groupSpaceId,
      customName: typeof metadata.customName === 'string' ? metadata.customName : null,
      groupNameUpdatedAtMs: typeof metadata.groupNameUpdatedAtMs === 'number'
        ? metadata.groupNameUpdatedAtMs
        : null,
    })),
    groupSpaceId,
    incomingTitle: incomingGroupTitle,
    incomingUpdatedAtMs: controlCreatedAtMs,
    replaceStoredTitle: envelope.kind === 'group-title-update',
  });
  const envelopeAdminUpdatedAtMs = typeof envelopeSessionMetadata.groupAdminUpdatedAtMs === 'number'
    && Number.isFinite(envelopeSessionMetadata.groupAdminUpdatedAtMs)
    ? envelopeSessionMetadata.groupAdminUpdatedAtMs
    : 0;
  const rootAdminUpdatedAtMs = typeof groupRootMetadata.groupAdminUpdatedAtMs === 'number'
    && Number.isFinite(groupRootMetadata.groupAdminUpdatedAtMs)
    ? groupRootMetadata.groupAdminUpdatedAtMs
    : 0;
  const storedAdminMetadata = rootAdminUpdatedAtMs >= envelopeAdminUpdatedAtMs
    ? groupRootMetadata
    : envelopeSessionMetadata;
  const storedAdminValue = Array.isArray(storedAdminMetadata.adminIdentityIds)
    ? storedAdminMetadata.adminIdentityIds
    : Array.isArray(envelopeSessionMetadata.adminIdentityIds)
      ? envelopeSessionMetadata.adminIdentityIds
      : groupRootMetadata.adminIdentityIds;
  const storedAdminIdentityIds = Array.isArray(storedAdminValue)
    ? storedAdminValue
        .filter((identityId): identityId is string => typeof identityId === 'string')
        .map((identityId) => identityId.trim())
        .filter(Boolean)
    : [];
  const adminSnapshot = stateOps.resolveAdminSnapshot({
    envelope,
    identityIdByAccount,
    createdByIdentityId,
    existingAdminIdentityIds: storedAdminIdentityIds,
    hasExistingSession: Boolean(envelopeSession),
    controlCreatedAtMs,
    storedAdminUpdatedAtMs: Math.max(envelopeAdminUpdatedAtMs, rootAdminUpdatedAtMs),
  });
  const actorIdentityId = identityIdByAccount.get(envelope.actor.accountId) ?? createdByIdentityId;
  const authorizedSessionTitle = stateOps.resolveSessionTitle({
    envelope,
    controlCreatedAtMs,
    identityIdByAccount,
    adminIdentityIds: adminSnapshot.adminIdentityIds,
  });
  const groupMetadata = {
    ...inheritedGroupRootMetadata,
    ...envelopeSessionMetadata,
    schemaVersion: 1,
    kind: 'chat-group',
    customName: groupTitleResolution.title || null,
    ...(groupTitleResolution.updatedAtMs > 0
      ? { groupNameUpdatedAtMs: groupTitleResolution.updatedAtMs }
      : {}),
    groupId: groupSpaceId,
    groupSpaceId,
    groupCreatorIdentityId: createdByIdentityId,
    adminIdentityIds: adminSnapshot.adminIdentityIds,
    ...(adminSnapshot.applies ? { groupAdminUpdatedAtMs: controlCreatedAtMs } : {}),
    initialContactIds: [...participantByAccount.keys()].map((accountId) => `cloud:${accountId}`),
    initialParticipantNames: participantNames,
    avatarAccountIds: [...participantByAccount.values()]
      .sort(compareCloudGroupParticipants)
      .map((participant) => participant.accountId),
    memberApprovalPolicy: 'under-50-open',
    createdFrom: envelope.kind === 'session-fork' || forkMetadata ? 'cloud-group-fork-sync' : 'cloud-group-sync',
    ...(authorizedSessionTitle ? {
      sessionTitleSource: authorizedSessionTitle.titleSource,
      sessionTitleRevision: authorizedSessionTitle.titleRevision,
      sessionTitlePolicyVersion: authorizedSessionTitle.titlePolicyVersion,
      sessionTitleUpdatedAtMs: authorizedSessionTitle.updatedAtMs,
      sessionTitleUpdatedByAccountId: authorizedSessionTitle.updatedByAccountId,
    } : {}),
    ...(forkMetadata ? { fork: forkMetadata } : {}),
  };
  const persistedSessionTitle = stateOps.cleanText(envelopeSession?.title);
  const openResult = await openOrCreateCanonicalSessionFast({
    id: envelope.groupId,
    kind: 'group',
    title: authorizedSessionTitle?.title ?? (persistedSessionTitle || 'New chat'),
    status: 'active',
    createdByIdentityId,
    primaryIdentityId: null,
    relationshipIdentityId: null,
    participantIdentityIds,
    metadata: groupMetadata,
  });
  nextState = stateOps.mergeOpenSession(nextState, openResult);
  if (!nextState) return null;

  const appliedSessionTitle = Boolean(
    sessionTitleUpdateTitle
    && authorizedSessionTitle
    && openResult.session.title === authorizedSessionTitle.title
    && envelopeSession?.title !== openResult.session.title,
  );
  if (appliedSessionTitle && authorizedSessionTitle?.updatedByAccountId !== account.accountId) {
    const titleAuthorAccountId = authorizedSessionTitle!.updatedByAccountId;
    const noticeRequest = cloudSessionTitleUpdateNoticeRequest({
      envelope,
      actorIdentityId: identityIdByAccount.get(titleAuthorAccountId) ?? actorIdentityId,
      actorDisplayName: participantByAccount.get(titleAuthorAccountId)?.displayName ?? 'Someone',
      createdAtMs: controlCreatedAtMs,
      cloudMessageId: cloudMessage.messageId,
    });
    if (noticeRequest && !nextState.messages.some((message) => message.id === noticeRequest.id)) {
      nextState = await appendCanonicalMessage(noticeRequest);
    }
  }
  if (groupTitleResolution.appliesIncoming && !isSelfAuthoredControl) {
    const noticeRequest = cloudGroupTitleUpdateNoticeRequest({
      envelope,
      actorIdentityId,
      createdAtMs: controlCreatedAtMs,
      cloudMessageId: cloudMessage.messageId,
    });
    if (noticeRequest && !nextState.messages.some((message) => message.id === noticeRequest.id)) {
      nextState = await appendCanonicalMessage(noticeRequest);
    }
  }
  for (const noticeRequest of cloudGroupMemberJoinNoticeRequests({
    envelope,
    actorIdentityId,
    identityIdByAccount,
    existingMessageIds: new Set(nextState.messages.map((message) => message.id)),
  })) {
    const persistedNotice = await upsertCanonicalMessageFast(noticeRequest);
    nextState = mergeCanonicalMessageRow(nextState, persistedNotice) ?? nextState;
  }
  for (const memberLeave of envelope.memberLeaves ?? []) {
    const removedIdentityId = identityIdByAccount.get(memberLeave.accountId)
      ?? `human:${memberLeave.accountId}`;
    const isStillActive = nextState.participants.some((participant) => (
      participant.sessionId === envelope.groupId
      && participant.identityId === removedIdentityId
      && participant.state === 'active'
    ));
    if (!isStillActive) continue;
    nextState = await removeCanonicalSessionParticipant({
      sessionId: envelope.groupId,
      identityId: removedIdentityId,
      removedByIdentityId: actorIdentityId,
    });
  }
  if (envelope.kind === 'group-message') {
    runtime.sessionPreparationCache.set(envelope.groupId, {
      signature: preparationSignature,
      localHumanIdentityId,
      groupSpaceId,
      participantByAccount,
      identityIdByAccount,
    });
  }
  if (envelope.kind !== 'group-message' || !envelope.message) {
    canonical.setState(nextState);
    return null;
  }
  return {
    account,
    cloudMessage,
    envelope,
    canonicalState,
    nextState,
    localHumanIdentityId,
    groupSpaceId,
    participantByAccount,
    identityIdByAccount,
  };
}

import {
  cloudGroupAdminAccountIds,
  cloudGroupSelfParticipant,
  cloudGroupSessionTitleSnapshotForControl,
  type CloudGroupControlEnvelope,
  type CloudGroupSessionTitleSnapshot,
} from './cloudGroupMessages';
import type { CloudGroupSessionRuntime } from './cloudGroupControlContext';

export function cloudGroupSessionPreparationSignature(
  envelope: CloudGroupControlEnvelope,
  account: NonNullable<CloudGroupSessionRuntime['account']>,
) {
  const participantsByAccount = new Map<string, {
    accountId: string;
    kordiId: string | null;
    displayName: string;
    avatarUrl: string | null;
    role: string | null;
  }>();
  for (const participant of [
    ...envelope.participants,
    cloudGroupSelfParticipant(account, 'self'),
    envelope.actor,
  ]) {
    const accountId = participant.accountId.trim();
    if (!accountId || participantsByAccount.has(accountId)) continue;
    participantsByAccount.set(accountId, {
      accountId,
      kordiId: participant.kordiId?.trim() || null,
      displayName: participant.displayName.trim(),
      avatarUrl: participant.avatarUrl?.trim() || null,
      role: participant.role?.trim() || null,
    });
  }
  const participants = [...participantsByAccount.values()]
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
  return JSON.stringify({
    kind: envelope.kind,
    groupId: envelope.groupId.trim(),
    groupSpaceId: envelope.groupSpaceId?.trim() || envelope.groupId.trim(),
    groupTitle: envelope.groupTitle?.trim() || null,
    createdByAccountId: envelope.createdByAccountId.trim(),
    participants,
    sessionTitle: envelope.sessionTitle ?? null,
    memberJoins: envelope.memberJoins ?? [],
    memberLeaves: envelope.memberLeaves ?? [],
    fork: envelope.fork ?? null,
  });
}

export function resolveCloudGroupAdminSnapshot(input: {
  envelope: Pick<CloudGroupControlEnvelope, 'kind' | 'actor' | 'participants' | 'createdByAccountId'>;
  identityIdByAccount: ReadonlyMap<string, string>;
  createdByIdentityId: string;
  existingAdminIdentityIds: string[];
  hasExistingSession: boolean;
  controlCreatedAtMs: number;
  storedAdminUpdatedAtMs: number;
}) {
  const actorIdentityId = input.identityIdByAccount.get(input.envelope.actor.accountId) ?? '';
  const actorCanChangeAdmins = !input.hasExistingSession
    ? input.envelope.kind === 'group-invite'
      && actorIdentityId === input.createdByIdentityId
    : actorIdentityId === input.createdByIdentityId;
  const applies = ['group-invite', 'group-update'].includes(input.envelope.kind)
    && actorCanChangeAdmins
    && input.controlCreatedAtMs >= input.storedAdminUpdatedAtMs;
  const advertisedAdminIdentityIds = cloudGroupAdminAccountIds(input.envelope)
    .map((accountId) => input.identityIdByAccount.get(accountId) ?? '')
    .filter(Boolean);
  return {
    applies,
    adminIdentityIds: [...new Set([
      input.createdByIdentityId,
      ...(applies ? advertisedAdminIdentityIds : input.existingAdminIdentityIds),
    ].filter(Boolean))],
  };
}

export function resolveAuthorizedCloudGroupSessionTitleSnapshot(input: {
  envelope: Pick<CloudGroupControlEnvelope, 'kind' | 'groupTitle' | 'actor' | 'sessionTitle'>;
  controlCreatedAtMs: number;
  identityIdByAccount: ReadonlyMap<string, string>;
  adminIdentityIds: readonly string[];
}): CloudGroupSessionTitleSnapshot | null {
  const snapshot = cloudGroupSessionTitleSnapshotForControl(
    input.envelope,
    input.controlCreatedAtMs,
  );
  if (!snapshot) return null;
  const updatedByIdentityId = input.identityIdByAccount.get(snapshot.updatedByAccountId)?.trim() ?? '';
  if (!updatedByIdentityId) return null;
  const adminIdentityIds = new Set(input.adminIdentityIds.map((identityId) => identityId.trim()).filter(Boolean));
  return adminIdentityIds.has(updatedByIdentityId) ? snapshot : null;
}

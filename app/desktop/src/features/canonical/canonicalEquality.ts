import type {
  CanonicalIdentity,
  CanonicalLocalProfile,
  CanonicalSessionMessage,
} from '@/kordi-app/types';

export function canonicalJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => canonicalJsonValuesEqual(item, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(rightRecord, key)
    && canonicalJsonValuesEqual(leftRecord[key], rightRecord[key])
  ));
}

export function canonicalProfilesEqual(
  left: CanonicalLocalProfile,
  right: CanonicalLocalProfile,
): boolean {
  return left.id === right.id
    && left.displayName === right.displayName
    && left.humanIdentityId === right.humanIdentityId
    && left.activeAgentIdentityId === right.activeAgentIdentityId
    && left.storageRoot === right.storageRoot
    && left.createdAtMs === right.createdAtMs
    && left.updatedAtMs === right.updatedAtMs;
}

export function canonicalIdentitiesEqual(
  left: CanonicalIdentity,
  right: CanonicalIdentity,
): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.displayName === right.displayName
    && left.ownerIdentityId === right.ownerIdentityId
    && left.source === right.source
    && left.sourceHostId === right.sourceHostId
    && left.sourceIdentityId === right.sourceIdentityId
    && left.humanId === right.humanId
    && left.agentId === right.agentId
    && left.avatarKey === right.avatarKey
    && left.profileImageUrl === right.profileImageUrl
    && left.createdAtMs === right.createdAtMs
    && left.updatedAtMs === right.updatedAtMs
    && canonicalJsonValuesEqual(left.metadata, right.metadata);
}

export function canonicalMessagesEqual(
  left: CanonicalSessionMessage,
  right: CanonicalSessionMessage,
): boolean {
  return left.id === right.id
    && left.sessionId === right.sessionId
    && left.senderIdentityId === right.senderIdentityId
    && left.senderRole === right.senderRole
    && left.messageKind === right.messageKind
    && left.contentText === right.contentText
    && left.parentMessageId === right.parentMessageId
    && left.delegatedExchangeId === right.delegatedExchangeId
    && left.status === right.status
    && left.sequenceNum === right.sequenceNum
    && left.createdAtMs === right.createdAtMs
    && left.updatedAtMs === right.updatedAtMs
    && left.contentHash === right.contentHash
    && left.sourceTransport === right.sourceTransport
    && left.sourceEventId === right.sourceEventId
    && canonicalJsonValuesEqual(left.content, right.content);
}

export function canonicalArraysEqual<T>(
  left: readonly T[],
  right: readonly T[],
  itemEqual: (leftItem: T, rightItem: T) => boolean = canonicalJsonValuesEqual,
): boolean {
  return left === right || (
    left.length === right.length
    && left.every((item, index) => itemEqual(item, right[index]))
  );
}

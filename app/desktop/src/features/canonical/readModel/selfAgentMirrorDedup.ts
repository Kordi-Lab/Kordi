import type { CanonicalIdentity, CanonicalSessionMessage } from '@/kordi-app/types';

import { contentRecord, stringValue } from './messageMapping';

function normalizedDuplicateText(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function pushMapArray<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const entries = map.get(key);
  if (entries) entries.push(value);
  else map.set(key, [value]);
}

function isActiveProcessingStatus(message: CanonicalSessionMessage) {
  const content = contentRecord(message.content);
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  return deliveryState === 'processing' || message.status.trim().toLowerCase() === 'processing';
}

function selfAgentLogicalSenderKey(
  message: CanonicalSessionMessage,
  identityById: ReadonlyMap<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  normalizeOwnedAgentIdentity = false,
) {
  if (message.senderRole !== 'owned-agent' || !normalizeOwnedAgentIdentity) {
    return `${message.senderRole}:${message.senderIdentityId}`;
  }
  const identity = identityById.get(message.senderIdentityId);
  const ownerIdentityId = identity?.ownerIdentityId?.trim() || profileHumanIdentityId?.trim() || '';
  const ownerIdentity = ownerIdentityId ? identityById.get(ownerIdentityId) : null;
  const identityMetadata = contentRecord(identity?.metadata);
  const ownerAccountId = ownerIdentity?.humanId?.trim()
    || ownerIdentity?.sourceIdentityId?.trim()
    || ownerIdentityId
    || stringValue(identityMetadata.accountId)?.trim();
  return `owned-agent:${ownerAccountId || 'self'}`;
}

function selfAgentMirrorMessageRelationKey(
  message: CanonicalSessionMessage,
  messageById: ReadonlyMap<string, CanonicalSessionMessage>,
  messageBySourceEventId: ReadonlyMap<string, CanonicalSessionMessage>,
  identityById: ReadonlyMap<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  normalizeOwnedAgentIdentity = false,
) {
  const content = contentRecord(message.content);
  const parentReference = message.parentMessageId?.trim()
    || stringValue(content.replyToMessageId)?.trim()
    || stringValue(content.cloudRequestMessageId)?.trim()
    || stringValue(content.requestId)?.trim()
    || '';
  if (!parentReference) return '';
  const parent = messageById.get(parentReference) ?? messageBySourceEventId.get(parentReference);
  if (!parent) return `reference:${parentReference}`;
  return [
    selfAgentLogicalSenderKey(
      parent,
      identityById,
      profileHumanIdentityId,
      normalizeOwnedAgentIdentity,
    ),
    parent.senderRole,
    parent.messageKind,
    parent.createdAtMs.toString(),
    normalizedDuplicateText(parent.contentText),
  ].join('\u001e');
}

function selfAgentMirrorDuplicateKey(
  message: CanonicalSessionMessage,
  messageById: ReadonlyMap<string, CanonicalSessionMessage>,
  messageBySourceEventId: ReadonlyMap<string, CanonicalSessionMessage>,
  identityById: ReadonlyMap<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  normalizeOwnedAgentIdentity = false,
) {
  const text = normalizedDuplicateText(message.contentText);
  if (!text) return null;
  return [
    message.sessionId,
    selfAgentLogicalSenderKey(
      message,
      identityById,
      profileHumanIdentityId,
      normalizeOwnedAgentIdentity,
    ),
    message.senderRole,
    message.messageKind,
    normalizeOwnedAgentIdentity && message.senderRole === 'owned-agent' && message.parentMessageId?.trim() ? '' : message.createdAtMs.toString(),
    text,
    selfAgentMirrorMessageRelationKey(
      message,
      messageById,
      messageBySourceEventId,
      identityById,
      profileHumanIdentityId,
      normalizeOwnedAgentIdentity,
    ),
  ].join('\u001f');
}

function selfAgentMirrorTransportPriority(message: CanonicalSessionMessage) {
  if (
    message.sourceTransport === 'canonical-fork-snapshot'
    && message.sourceEventId?.startsWith('fork-snapshot:')
  ) return 0;
  if (message.sourceTransport === 'canonical-fork-snapshot') return 1;
  if (message.sourceTransport === 'desktop-chat-ui') return 2;
  if (message.sourceTransport === 'desktop-chat') return 3;
  if (message.sourceTransport === 'cloud-self-agent') return 4;
  return Number.MAX_SAFE_INTEGER;
}

function isTerminalOwnedAgentMessage(message: CanonicalSessionMessage) {
  if (message.senderRole !== 'owned-agent' || message.messageKind !== 'agent-turn') return false;
  const content = contentRecord(message.content);
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  const status = message.status.trim().toLowerCase();
  const terminal = ['complete', 'completed', 'succeeded', 'responded', 'failed', 'cancelled', 'canceled'];
  return terminal.includes(deliveryState ?? '') || terminal.includes(status);
}

export function selfAgentMirrorDuplicateIds(
  messages: CanonicalSessionMessage[],
  identityById: ReadonlyMap<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  normalizeOwnedAgentIdentity = false,
) {
  // ponytail: text/time fallback only repairs legacy mirrors without stable
  // relation aliases; remove it once every deployed client writes those IDs.
  const legacyMirrorWindowMs = 10 * 60_000;
  const duplicateIds = new Set<string>();
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const messageBySourceEventId = new Map(
    messages.flatMap((message) => message.sourceEventId ? [[message.sourceEventId, message] as const] : []),
  );
  const candidatesByKey = new Map<string, CanonicalSessionMessage[]>();
  for (const message of messages) {
    if (
      message.sourceTransport !== 'canonical-fork-snapshot'
      && message.sourceTransport !== 'desktop-chat'
      && message.sourceTransport !== 'desktop-chat-ui'
      && message.sourceTransport !== 'cloud-self-agent'
    ) continue;
    const key = selfAgentMirrorDuplicateKey(
      message,
      messageById,
      messageBySourceEventId,
      identityById,
      profileHumanIdentityId,
      normalizeOwnedAgentIdentity,
    );
    if (!key) continue;
    pushMapArray(candidatesByKey, key, message);
  }

  for (const candidates of candidatesByKey.values()) {
    if (candidates.length < 2) continue;
    const hasCloudMirror = candidates.some((message) => message.sourceTransport === 'cloud-self-agent');
    const hasPreferredLocalCopy = candidates.some((message) => (
      message.sourceTransport === 'canonical-fork-snapshot'
      || message.sourceTransport === 'desktop-chat'
      || message.sourceTransport === 'desktop-chat-ui'
    ));
    const hasCanonicalSnapshotOrigin = candidates.some((message) => (
      message.sourceTransport === 'canonical-fork-snapshot'
      && message.sourceEventId?.startsWith('fork-snapshot:')
    ));
    if ((!hasCloudMirror || !hasPreferredLocalCopy) && !hasCanonicalSnapshotOrigin) continue;

    const preferred = [...candidates].sort((left, right) => (
      selfAgentMirrorTransportPriority(left) - selfAgentMirrorTransportPriority(right)
      || left.sequenceNum - right.sequenceNum
      || left.id.localeCompare(right.id)
    ))[0];
    for (const candidate of candidates) {
      if (candidate.id !== preferred.id) duplicateIds.add(candidate.id);
    }
  }
  if (normalizeOwnedAgentIdentity) {
    const terminalCloudRequestIds = new Set(messages.flatMap((message) => {
      if (message.sourceTransport !== 'cloud-self-agent' || !isTerminalOwnedAgentMessage(message)) return [];
      const requestId = stringValue(contentRecord(message.content).cloudRequestMessageId)?.trim();
      return requestId ? [requestId] : [];
    }));
    const localTerminalMessages = messages.filter((message) => (
      message.sourceTransport === 'desktop-chat'
      && isTerminalOwnedAgentMessage(message)
    ));
    const localTerminalRelations = new Set(localTerminalMessages.flatMap((message) => {
      const relation = selfAgentMirrorMessageRelationKey(
        message,
        messageById,
        messageBySourceEventId,
        identityById,
        profileHumanIdentityId,
        true,
      );
      return relation ? [relation] : [];
    }));
    for (const message of messages) {
      if (message.sourceTransport !== 'cloud-self-agent') continue;
      if (isActiveProcessingStatus(message)) {
        const cloudRequestId = stringValue(contentRecord(message.content).cloudRequestMessageId)?.trim();
        if (cloudRequestId && terminalCloudRequestIds.has(cloudRequestId)) {
          duplicateIds.add(message.id);
          continue;
        }
        const relation = selfAgentMirrorMessageRelationKey(
          message,
          messageById,
          messageBySourceEventId,
          identityById,
          profileHumanIdentityId,
          true,
        );
        if (relation && localTerminalRelations.has(relation)) {
          duplicateIds.add(message.id);
          continue;
        }
        const partialText = normalizedDuplicateText(message.contentText);
        const sender = selfAgentLogicalSenderKey(
          message,
          identityById,
          profileHumanIdentityId,
          true,
        );
        const localTerminal = partialText && localTerminalMessages.find((candidate) => (
          candidate.sessionId === message.sessionId
          && normalizedDuplicateText(candidate.contentText).startsWith(partialText)
          && selfAgentLogicalSenderKey(
            candidate,
            identityById,
            profileHumanIdentityId,
            true,
          ) === sender
          && Math.abs(candidate.createdAtMs - message.createdAtMs) <= legacyMirrorWindowMs
        ));
        if (localTerminal) duplicateIds.add(message.id);
        continue;
      }
      if (!isTerminalOwnedAgentMessage(message)) continue;
      const text = normalizedDuplicateText(message.contentText);
      if (!text) continue;
      const sender = selfAgentLogicalSenderKey(
        message,
        identityById,
        profileHumanIdentityId,
        true,
      );
      const localMirror = localTerminalMessages.find((candidate) => (
        candidate.sessionId === message.sessionId
        && normalizedDuplicateText(candidate.contentText) === text
        && selfAgentLogicalSenderKey(
          candidate,
          identityById,
          profileHumanIdentityId,
          true,
        ) === sender
        && Math.abs(candidate.createdAtMs - message.createdAtMs) <= legacyMirrorWindowMs
      ));
      if (localMirror) duplicateIds.add(message.id);
    }
  }
  return duplicateIds;
}

import type { CanonicalSessionState } from '@/kordi-app/types';

import type { CloudMessage } from './authClient';
import { parseCloudGroupControl, type CloudGroupControlEnvelope } from './cloudGroupMessages';

export type CloudDeliveryReader = {
  accountId: string;
  identityId: string;
  readAt: string;
};

export type CloudDeliverySummary = {
  state: 'delivered' | 'read';
  readers: readonly CloudDeliveryReader[];
};

export type IndexedCloudGroupRow = {
  wire: CloudMessage;
  envelope: CloudGroupControlEnvelope;
  canonicalMessageId: string | null;
};

export type CloudMessageIndex = {
  allMessages: readonly CloudMessage[];
  byMessageId: ReadonlyMap<string, CloudMessage>;
  byPeerId: ReadonlyMap<string, readonly CloudMessage[]>;
  bySessionId: ReadonlyMap<string, readonly CloudMessage[]>;
  groupRows: readonly IndexedCloudGroupRow[];
  groupRowByWireMessageId: ReadonlyMap<string, IndexedCloudGroupRow>;
  replayRows: readonly IndexedCloudGroupRow[];
  groupRowsBySessionId: ReadonlyMap<string, readonly IndexedCloudGroupRow[]>;
  groupRowsBySpaceId: ReadonlyMap<string, readonly IndexedCloudGroupRow[]>;
  deliveryByMessageId: ReadonlyMap<string, CloudDeliverySummary>;
  peerRevisionByPeerId: ReadonlyMap<string, string>;
  sessionRevisionBySessionId: ReadonlyMap<string, string>;
  revision: string;
};

export type CloudMessageIndexOptions = {
  parseGroupControl?: (body: string) => CloudGroupControlEnvelope | null;
};

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function exposeArray<T>(values: T[]): readonly T[] {
  return import.meta.env?.DEV ? Object.freeze(values) : values;
}

function pushMapValue<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}

function exposeArrayMap<K, V>(source: Map<K, V[]>): ReadonlyMap<K, readonly V[]> {
  const result = new Map<K, readonly V[]>();
  for (const [key, values] of source) result.set(key, exposeArray(values));
  return result;
}

function mergeDuplicateWire(previous: CloudMessage, incoming: CloudMessage): CloudMessage {
  return {
    ...previous,
    ...incoming,
    attachments: incoming.attachments ?? previous.attachments,
  };
}

function messageSort(left: CloudMessage, right: CloudMessage) {
  return left.createdAt.localeCompare(right.createdAt)
    || left.messageId.localeCompare(right.messageId);
}

function revisionForMessages(messages: readonly CloudMessage[]): string {
  if (messages.length === 0) return '0::';
  let newest = messages[0];
  let newestTimestamp = cleanText(newest.readAt) || cleanText(newest.deliveredAt) || cleanText(newest.createdAt);
  let fingerprint = 2_166_136_261;
  const addFingerprintValue = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      fingerprint ^= value.charCodeAt(index);
      fingerprint = Math.imul(fingerprint, 16_777_619);
    }
  };
  for (const message of messages) {
    const effectiveTimestamp = cleanText(message.readAt) || cleanText(message.deliveredAt) || cleanText(message.createdAt);
    if (
      effectiveTimestamp > newestTimestamp
      || (effectiveTimestamp === newestTimestamp && message.messageId > newest.messageId)
    ) {
      newest = message;
      newestTimestamp = effectiveTimestamp;
    }
    addFingerprintValue(message.messageId);
    addFingerprintValue(message.createdAt);
    addFingerprintValue(message.deliveredAt ?? '');
    addFingerprintValue(message.readAt ?? '');
    addFingerprintValue(message.sessionId ?? '');
    addFingerprintValue(String(message.body.length));
    for (const attachment of message.attachments ?? []) {
      addFingerprintValue(attachment.attachmentId);
      addFingerprintValue(attachment.downloadUrl ?? '');
      addFingerprintValue(attachment.localPath ?? '');
    }
  }
  return [
    messages.length,
    newest.messageId,
    newestTimestamp,
    fingerprint >>> 0,
  ].join(':');
}

export function cloudGroupReplayKeyForRow(row: IndexedCloudGroupRow) {
  if (row.envelope.kind === 'group-message' && row.canonicalMessageId) {
    return `${row.envelope.kind}:${row.envelope.groupId}:${row.canonicalMessageId}`;
  }
  return `${row.envelope.kind}:${row.envelope.groupId}:${row.wire.body}`;
}

export function buildCloudMessageIndex(
  accountId: string | null | undefined,
  messagesByPeer: Record<string, CloudMessage[]>,
  options: CloudMessageIndexOptions = {},
): CloudMessageIndex {
  const localAccountId = cleanText(accountId);
  const parseGroupControl = options.parseGroupControl ?? parseCloudGroupControl;
  const uniqueByMessageId = new Map<string, CloudMessage>();
  const peerMessageIds = new Map<string, Set<string>>();

  for (const [peerId, messages] of Object.entries(messagesByPeer)) {
    const normalizedPeerId = cleanText(peerId);
    if (!normalizedPeerId) continue;
    const ids = peerMessageIds.get(normalizedPeerId) ?? new Set<string>();
    for (const message of messages) {
      const messageId = cleanText(message.messageId);
      if (!messageId) continue;
      const previous = uniqueByMessageId.get(messageId);
      uniqueByMessageId.set(messageId, previous ? mergeDuplicateWire(previous, message) : message);
      ids.add(messageId);
    }
    peerMessageIds.set(normalizedPeerId, ids);
  }

  const allMessages = [...uniqueByMessageId.values()].sort(messageSort);
  const byMessageId = new Map(allMessages.map((message) => [message.messageId, message]));
  const mutableByPeerId = new Map<string, CloudMessage[]>();
  for (const [peerId, messageIds] of peerMessageIds) {
    mutableByPeerId.set(peerId, [...messageIds]
      .flatMap((messageId) => {
        const message = byMessageId.get(messageId);
        return message ? [message] : [];
      })
      .sort(messageSort));
  }
  const byPeerId = exposeArrayMap(mutableByPeerId);
  const mutableMessagesBySessionId = new Map<string, CloudMessage[]>();
  for (const wire of allMessages) {
    const sessionId = cleanText(wire.sessionId);
    if (sessionId) pushMapValue(mutableMessagesBySessionId, sessionId, wire);
  }

  const groupRows: IndexedCloudGroupRow[] = [];
  const groupRowByWireMessageId = new Map<string, IndexedCloudGroupRow>();
  const mutableRowsBySessionId = new Map<string, IndexedCloudGroupRow[]>();
  const mutableRowsBySpaceId = new Map<string, IndexedCloudGroupRow[]>();
  const replayRowsByKey = new Map<string, IndexedCloudGroupRow>();
  const mutableDelivery = new Map<string, {
    state: CloudDeliverySummary['state'];
    readersByAccountId: Map<string, CloudDeliveryReader>;
  }>();

  for (const wire of allMessages) {
    const envelope = parseGroupControl(wire.body);
    if (!envelope) continue;
    const canonicalMessageId = cleanText(envelope.message?.id) || null;
    const row: IndexedCloudGroupRow = { wire, envelope, canonicalMessageId };
    groupRows.push(row);
    groupRowByWireMessageId.set(wire.messageId, row);
    pushMapValue(mutableRowsBySessionId, envelope.groupId, row);
    if (cleanText(wire.sessionId) !== envelope.groupId) {
      pushMapValue(mutableMessagesBySessionId, envelope.groupId, wire);
    }
    const groupSpaceId = cleanText(envelope.groupSpaceId);
    if (groupSpaceId) pushMapValue(mutableRowsBySpaceId, groupSpaceId, row);
    const replayKey = cloudGroupReplayKeyForRow(row);
    if (!replayRowsByKey.has(replayKey)) replayRowsByKey.set(replayKey, row);

    if (
      !localAccountId
      || !canonicalMessageId
      || wire.fromAccountId !== localAccountId
      || wire.direction !== 'outgoing'
    ) continue;
    const summary = mutableDelivery.get(canonicalMessageId) ?? {
      state: 'delivered' as const,
      readersByAccountId: new Map<string, CloudDeliveryReader>(),
    };
    const readAt = cleanText(wire.readAt);
    const recipientAccountId = cleanText(wire.toAccountId);
    if (readAt) {
      summary.state = 'read';
      if (recipientAccountId) {
        const previousReader = summary.readersByAccountId.get(recipientAccountId);
        if (!previousReader || previousReader.readAt < readAt) {
          summary.readersByAccountId.set(recipientAccountId, {
            accountId: recipientAccountId,
            identityId: `human:${recipientAccountId}`,
            readAt,
          });
        }
      }
    }
    mutableDelivery.set(canonicalMessageId, summary);
  }

  const deliveryByMessageId = new Map<string, CloudDeliverySummary>();
  for (const [messageId, summary] of mutableDelivery) {
    deliveryByMessageId.set(messageId, {
      state: summary.state,
      readers: exposeArray([...summary.readersByAccountId.values()]
        .sort((left, right) => left.accountId.localeCompare(right.accountId))),
    });
  }

  const groupRowsBySessionId = exposeArrayMap(mutableRowsBySessionId);
  const groupRowsBySpaceId = exposeArrayMap(mutableRowsBySpaceId);
  const bySessionId = exposeArrayMap(mutableMessagesBySessionId);
  const peerRevisionByPeerId = new Map<string, string>();
  for (const [peerId, messages] of byPeerId) {
    peerRevisionByPeerId.set(peerId, revisionForMessages(messages));
  }
  const sessionRevisionBySessionId = new Map<string, string>();
  for (const [sessionId, messages] of bySessionId) {
    sessionRevisionBySessionId.set(sessionId, revisionForMessages(messages));
  }

  return {
    allMessages: exposeArray(allMessages),
    byMessageId,
    byPeerId,
    bySessionId,
    groupRows: exposeArray(groupRows),
    groupRowByWireMessageId,
    replayRows: exposeArray([...replayRowsByKey.values()]),
    groupRowsBySessionId,
    groupRowsBySpaceId,
    deliveryByMessageId,
    peerRevisionByPeerId,
    sessionRevisionBySessionId,
    revision: revisionForMessages(allMessages),
  };
}

function deliveryReadersEqual(existing: unknown, readers: readonly CloudDeliveryReader[]) {
  const summary = contentRecord(existing);
  const count = typeof summary.count === 'number' && Number.isFinite(summary.count)
    ? Math.max(0, Math.floor(summary.count))
    : 0;
  const participants = Array.isArray(summary.participants) ? summary.participants : [];
  if (count !== readers.length || participants.length !== readers.length) return false;
  return readers.every((reader, index) => {
    const participant = contentRecord(participants[index]);
    return participant.accountId === reader.accountId
      && participant.identityId === reader.identityId
      && participant.readAt === reader.readAt;
  });
}

export function patchCanonicalDeliverySummaries(
  current: CanonicalSessionState | null,
  deliveryByMessageId: ReadonlyMap<string, CloudDeliverySummary>,
): CanonicalSessionState | null {
  if (!current || deliveryByMessageId.size === 0) return current;
  let changed = false;
  const messages = current.messages.map((message) => {
    if (message.senderRole !== 'user') return message;
    const summary = deliveryByMessageId.get(message.id);
    if (!summary) return message;
    const content = contentRecord(message.content);
    const readersMatch = deliveryReadersEqual(content.readReceiptSummary, summary.readers);
    if (
      message.status === 'sent'
      && content.deliveryState === summary.state
      && readersMatch
    ) return message;
    changed = true;
    return {
      ...message,
      status: 'sent',
      content: {
        ...content,
        deliveryState: summary.state,
        readReceiptSummary: summary.readers.length > 0
          ? { count: summary.readers.length, participants: summary.readers }
          : null,
      },
    };
  });
  return changed ? { ...current, messages } : current;
}

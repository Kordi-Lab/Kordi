import type { CanonicalMessageSourceRef } from '@/features/canonical/canonicalMessageSources';
import type { CanonicalSessionState } from '@/kordi-app/types';
import { legacySessionTitleFromMessageText } from '@/features/chat/sessionTitlePolicy';
import {
  beginChatPerformanceSpan,
  chatPerformancePayloadBytes,
  finishChatPerformanceSpan,
} from '@/features/performance/chatPerformance';

import type { CloudMessage } from './authClient';
import { parseCloudGroupControl, type CloudGroupControlEnvelope } from './cloudGroupMessages';
import { compareCloudMessages } from './cloudMessageMerge';
import { cloudMessageRevision } from './cloudMessageRevision';

export { patchCanonicalCloudReactions } from './cloudReactionProjection';

export type CloudDeliveryReader = {
  accountId: string;
  identityId: string;
  readAt: string | null;
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
  sourceAccountId: string;
  sourceMessagesByPeer: Record<string, CloudMessage[]>;
  allMessages: readonly CloudMessage[];
  byMessageId: ReadonlyMap<string, CloudMessage>;
  byPeerId: ReadonlyMap<string, readonly CloudMessage[]>;
  bySessionId: ReadonlyMap<string, readonly CloudMessage[]>;
  groupRows: readonly IndexedCloudGroupRow[];
  groupRowByWireMessageId: ReadonlyMap<string, IndexedCloudGroupRow>;
  replayRows: readonly IndexedCloudGroupRow[];
  groupRowsBySessionId: ReadonlyMap<string, readonly IndexedCloudGroupRow[]>;
  groupRowsBySpaceId: ReadonlyMap<string, readonly IndexedCloudGroupRow[]>;
  legacyGroupSessionTitlesById: ReadonlyMap<string, string>;
  deliveryByMessageId: ReadonlyMap<string, CloudDeliverySummary>;
  peerRevisionByPeerId: ReadonlyMap<string, string>;
  sessionRevisionBySessionId: ReadonlyMap<string, string>;
  revision: string;
};

export type CloudMessageIndexOptions = {
  parseGroupControl?: (body: string) => CloudGroupControlEnvelope | null;
  previousIndex?: CloudMessageIndex | null;
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
    voiceMessage: incoming.voiceMessage ?? previous.voiceMessage,
    // Some compatibility projections omit the semantic kind. Never allow a
    // less complete duplicate to turn a non-executable system event back into
    // an ordinary agent request.
    messageKind: incoming.messageKind ?? previous.messageKind,
  };
}

function messageSort(left: CloudMessage, right: CloudMessage) {
  return compareCloudMessages(left, right);
}

export function cloudGroupReplayKeyForRow(row: IndexedCloudGroupRow) {
  if (row.envelope.kind === 'group-message' && row.canonicalMessageId) {
    return `${row.envelope.kind}:${row.envelope.groupId}:${row.canonicalMessageId}`;
  }
  return `${row.envelope.kind}:${row.envelope.groupId}:${row.wire.body}`;
}

export function cloudGroupCanonicalMessageSource(
  wire: Pick<CloudMessage, 'messageId' | 'version'>,
  envelope: CloudGroupControlEnvelope,
): CanonicalMessageSourceRef | null {
  const message = envelope.message;
  const messageId = wire.messageId.trim();
  if (envelope.kind !== 'group-message' || !message || !messageId) return null;
  const sourceTransport = message.forkSnapshot
    ? 'cloud-group-fork-snapshot'
    : message.senderKind === 'agent'
      ? 'cloud-group-agent'
      : 'cloud-group';
  const version = Number(wire.version);
  const versionedSource = Number.isSafeInteger(version) && (
    version > 1
    || /^call\.(?:started|ended)\./.test(message.messageKind?.trim() ?? '')
  );
  return {
    sourceTransport,
    sourceEventId: `${sourceTransport}:${messageId}${versionedSource ? `:${version}` : ''}`,
  };
}

export function canonicalMessageSourceKey(source: CanonicalMessageSourceRef) {
  return JSON.stringify([source.sourceTransport, source.sourceEventId]);
}

export function cloudGroupReplayRowsAfterDurableHistory(
  rows: readonly IndexedCloudGroupRow[],
  existingSourceKeys: ReadonlySet<string>,
) {
  const latestMessageRowByGroup = new Map<string, IndexedCloudGroupRow>();
  for (const row of rows) {
    if (cloudGroupCanonicalMessageSource(row.wire, row.envelope)) {
      latestMessageRowByGroup.set(row.envelope.groupId, row);
    }
  }
  return rows.filter((row) => {
    const source = cloudGroupCanonicalMessageSource(row.wire, row.envelope);
    if (!source || !existingSourceKeys.has(canonicalMessageSourceKey(source))) return true;
    // One durable tail row per group still refreshes the compact session and
    // participant shell. The historical message itself remains paged from
    // SQLite and is not replayed into React memory.
    return latestMessageRowByGroup.get(row.envelope.groupId) === row;
  });
}

export function buildCloudMessageIndex(
  accountId: string | null | undefined,
  messagesByPeer: Record<string, CloudMessage[]>,
  options: CloudMessageIndexOptions = {},
): CloudMessageIndex {
  const localAccountId = cleanText(accountId);
  if (
    options.previousIndex?.sourceAccountId === localAccountId
    && options.previousIndex.sourceMessagesByPeer === messagesByPeer
  ) {
    return options.previousIndex;
  }
  const performanceSpan = beginChatPerformanceSpan('cloud-message-index');
  const parseGroupControl = options.parseGroupControl ?? parseCloudGroupControl;
  const previousGroupRowByWireMessageId = options.previousIndex?.groupRowByWireMessageId;
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
  const byPeerId = new Map<string, readonly CloudMessage[]>();
  for (const [peerId, messageIds] of peerMessageIds) {
    const messages = [...messageIds]
      .flatMap((messageId) => {
        const message = byMessageId.get(messageId);
        return message ? [message] : [];
      })
      .sort(messageSort);
    const previousMessages = options.previousIndex?.byPeerId.get(peerId);
    byPeerId.set(peerId, previousMessages
      && previousMessages.length === messages.length
      && previousMessages.every((message, index) => message === messages[index])
      ? previousMessages
      : exposeArray(messages));
  }
  const mutableMessagesBySessionId = new Map<string, CloudMessage[]>();
  for (const wire of allMessages) {
    const sessionId = cleanText(wire.sessionId);
    if (sessionId) pushMapValue(mutableMessagesBySessionId, sessionId, wire);
  }

  const groupRows: IndexedCloudGroupRow[] = [];
  const groupRowByWireMessageId = new Map<string, IndexedCloudGroupRow>();
  const mutableRowsBySessionId = new Map<string, IndexedCloudGroupRow[]>();
  const mutableRowsBySpaceId = new Map<string, IndexedCloudGroupRow[]>();
  const legacyGroupSessionTitlesById = new Map<string, string>();
  const legacyGroupSessionTitleSeededIds = new Set<string>();
  const replayRowsByKey = new Map<string, IndexedCloudGroupRow>();
  const mutableDelivery = new Map<string, {
    state: CloudDeliverySummary['state'];
    readersByAccountId: Map<string, CloudDeliveryReader>;
  }>();

  for (const wire of allMessages) {
    const previousRow = previousGroupRowByWireMessageId?.get(wire.messageId);
    const envelope = previousRow?.wire.body === wire.body
      ? previousRow.envelope
      : parseGroupControl(wire.body);
    if (!envelope) continue;
    const canonicalMessageId = cleanText(envelope.message?.id) || null;
    const row: IndexedCloudGroupRow = previousRow?.wire === wire
      ? previousRow
      : { wire, envelope, canonicalMessageId };
    groupRows.push(row);
    groupRowByWireMessageId.set(wire.messageId, row);
    pushMapValue(mutableRowsBySessionId, envelope.groupId, row);
    if (cleanText(wire.sessionId) !== envelope.groupId) {
      pushMapValue(mutableMessagesBySessionId, envelope.groupId, wire);
    }
    const groupSpaceId = cleanText(envelope.groupSpaceId);
    if (groupSpaceId) pushMapValue(mutableRowsBySpaceId, groupSpaceId, row);
    if (
      envelope.kind === 'group-message'
      && !envelope.message?.forkSnapshot
      && !legacyGroupSessionTitleSeededIds.has(envelope.groupId)
    ) {
      legacyGroupSessionTitleSeededIds.add(envelope.groupId);
      const title = legacySessionTitleFromMessageText(envelope.message?.text);
      if (title) legacyGroupSessionTitlesById.set(envelope.groupId, title);
    }
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
    const readerAccountIds = (wire.readByAccountIds ?? (readAt ? [wire.toAccountId] : []))
      .map(cleanText)
      .filter((accountId) => accountId && accountId !== localAccountId);
    if (readerAccountIds.length > 0) {
      summary.state = 'read';
      const readerReadAt = wire.readByAccountIds === undefined ? readAt : null;
      for (const recipientAccountId of readerAccountIds) {
        const previousReader = summary.readersByAccountId.get(recipientAccountId);
        if (!previousReader || cleanText(previousReader.readAt) < cleanText(readerReadAt)) {
          summary.readersByAccountId.set(recipientAccountId, {
            accountId: recipientAccountId,
            identityId: `human:${recipientAccountId}`,
            readAt: readerReadAt,
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
    const previousMessages = options.previousIndex?.byPeerId.get(peerId);
    const previousRevision = options.previousIndex?.peerRevisionByPeerId.get(peerId);
    peerRevisionByPeerId.set(peerId, previousMessages === messages && previousRevision
      ? previousRevision
      : cloudMessageRevision(messages));
  }
  const sessionRevisionBySessionId = new Map<string, string>();
  for (const [sessionId, messages] of bySessionId) {
    sessionRevisionBySessionId.set(sessionId, cloudMessageRevision(messages));
  }

  const index = {
    sourceAccountId: localAccountId,
    sourceMessagesByPeer: messagesByPeer,
    allMessages: exposeArray(allMessages),
    byMessageId,
    byPeerId,
    bySessionId,
    groupRows: exposeArray(groupRows),
    groupRowByWireMessageId,
    replayRows: exposeArray([...replayRowsByKey.values()]),
    groupRowsBySessionId,
    groupRowsBySpaceId,
    legacyGroupSessionTitlesById,
    deliveryByMessageId,
    peerRevisionByPeerId,
    sessionRevisionBySessionId,
    revision: [...peerRevisionByPeerId.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([peerId, revision]) => `${peerId}:${revision}`)
      .join('|'),
  };
  finishChatPerformanceSpan(performanceSpan, () => ({
    messageCount: allMessages.length,
    rowCount: groupRows.length,
    payloadBytes: allMessages.reduce(
      (bytes, message) => bytes + (chatPerformancePayloadBytes(message.body) ?? 0),
      0,
    ),
  }));
  return index;
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

function monotonicDeliveryReaders(existing: unknown, incoming: readonly CloudDeliveryReader[]) {
  const participants = contentRecord(existing).participants;
  const readersByAccountId = new Map<string, CloudDeliveryReader>();
  if (Array.isArray(participants)) {
    for (const value of participants) {
      const participant = contentRecord(value);
      const identityId = typeof participant.identityId === 'string' ? participant.identityId.trim() : '';
      const accountId = typeof participant.accountId === 'string'
        ? participant.accountId.trim()
        : identityId.startsWith('human:') ? identityId.slice(6) : '';
      if (!accountId) continue;
      readersByAccountId.set(accountId, {
        accountId,
        identityId: identityId || `human:${accountId}`,
        readAt: typeof participant.readAt === 'string' ? participant.readAt : null,
      });
    }
  }
  for (const reader of incoming) {
    const previous = readersByAccountId.get(reader.accountId);
    if (!previous || cleanText(previous.readAt) < cleanText(reader.readAt)) {
      readersByAccountId.set(reader.accountId, reader);
    }
  }
  return [...readersByAccountId.values()]
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
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
    const readers = monotonicDeliveryReaders(content.readReceiptSummary, summary.readers);
    const existingReceipt = contentRecord(content.readReceiptSummary);
    const existingReceiptCount = typeof existingReceipt.count === 'number' && Number.isFinite(existingReceipt.count)
      ? Math.max(0, Math.floor(existingReceipt.count))
      : 0;
    const deliveryState = content.deliveryState === 'read' || summary.state === 'read' || readers.length > 0
      ? 'read'
      : 'delivered';
    const readReceiptSummary = readers.length > 0
      ? { count: readers.length, participants: readers }
      : existingReceiptCount > 0 ? content.readReceiptSummary : null;
    const readersMatch = readReceiptSummary === content.readReceiptSummary
      || deliveryReadersEqual(content.readReceiptSummary, readers);
    if (message.status === 'sent' && content.deliveryState === deliveryState && readersMatch) return message;
    changed = true;
    return {
      ...message,
      status: 'sent',
      content: {
        ...content,
        deliveryState,
        readReceiptSummary,
      },
    };
  });
  return changed ? { ...current, messages } : current;
}

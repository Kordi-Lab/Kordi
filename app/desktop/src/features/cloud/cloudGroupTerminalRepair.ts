import type { CanonicalSessionMessage } from '@/kordi-app/types';
import {
  cloudGroupReplayKeyForRow,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function terminalResponseCoordinates(row: IndexedCloudGroupRow) {
  const message = row.envelope.kind === 'group-message'
    ? row.envelope.message
    : null;
  if (!message || message.senderKind !== 'agent') return null;
  const deliveryState = cleanText(message.deliveryState).toLowerCase();
  if (
    !deliveryState
    || ['sending', 'queued', 'processing'].includes(deliveryState)
  ) return null;
  const requestId = cleanText(message.requestId)
    || cleanText(message.replyToMessageId);
  const senderAccountId = cleanText(message.senderAccountId);
  if (!requestId || !senderAccountId) return null;
  return {
    groupId: row.envelope.groupId.trim(),
    requestId,
    senderAccountId,
  };
}

function coordinatesKey({
  groupId,
  requestId,
  senderAccountId,
}: NonNullable<ReturnType<typeof terminalResponseCoordinates>>): string {
  return `${groupId}\u0000${senderAccountId}\u0000${requestId}`;
}

function processingSlotCoordinatesKey(
  message: CanonicalSessionMessage,
): string | null {
  const senderIdentityPrefix = 'agent:cloud:';
  if (
    !message.senderIdentityId.startsWith(senderIdentityPrefix)
    || !message.sourceTransport?.startsWith('cloud-group-agent')
  ) return null;
  const content = contentRecord(message.content);
  const linkedRequestId = cleanText(message.parentMessageId)
    || cleanText(content.requestId)
    || cleanText(content.replyToMessageId);
  if (!linkedRequestId) return null;
  const deliveryState = cleanText(content.deliveryState).toLowerCase();
  const pending = message.status === 'queued'
    || message.status === 'processing'
    || deliveryState === 'queued'
    || deliveryState === 'processing';
  if (!pending) return null;
  return coordinatesKey({
    groupId: message.sessionId,
    requestId: linkedRequestId,
    senderAccountId: message.senderIdentityId.slice(senderIdentityPrefix.length),
  });
}

export function cloudGroupTerminalRepairReplayKey(
  row: IndexedCloudGroupRow,
): string {
  return `terminal-repair:${cloudGroupReplayKeyForRow(row)}`
    + `:${row.wire.messageId}`;
}

export function cloudGroupTerminalRepairReplayRows(
  rows: readonly IndexedCloudGroupRow[],
  messages: readonly CanonicalSessionMessage[],
): IndexedCloudGroupRow[] {
  if (messages.length === 0) return [];
  const processingSlotKeys = new Set<string>();
  for (const message of messages) {
    const key = processingSlotCoordinatesKey(message);
    if (key) processingSlotKeys.add(key);
  }
  if (processingSlotKeys.size === 0) return [];
  return rows.filter((row) => {
    const coordinates = terminalResponseCoordinates(row);
    return coordinates !== null
      && processingSlotKeys.has(coordinatesKey(coordinates));
  });
}

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

function agentSlotCoordinatesKey(
  message: CanonicalSessionMessage,
): string | null {
  const senderIdentityPrefix = 'agent:cloud:';
  if (
    !message.sourceTransport?.startsWith('cloud-group-agent')
  ) return null;
  const content = contentRecord(message.content);
  const senderAccountId = cleanText(content.senderOwnerAccountId)
    || (
      message.senderIdentityId.startsWith(senderIdentityPrefix)
      && !message.senderIdentityId.startsWith('agent:cloud-agent:')
        ? message.senderIdentityId.slice(senderIdentityPrefix.length)
        : ''
    );
  if (!senderAccountId) return null;
  const linkedRequestId = cleanText(message.parentMessageId)
    || cleanText(content.requestId)
    || cleanText(content.replyToMessageId);
  if (!linkedRequestId) return null;
  return coordinatesKey({
    groupId: message.sessionId,
    requestId: linkedRequestId,
    senderAccountId,
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
  const requestKeys = new Set(messages.map(
    (message) => `${message.sessionId}\u0000${message.id}`,
  ));
  const agentSlotKeys = new Set<string>();
  const processingSlotKeys = new Set<string>();
  for (const message of messages) {
    const key = agentSlotCoordinatesKey(message);
    if (!key) continue;
    agentSlotKeys.add(key);
    const deliveryState = cleanText(contentRecord(message.content).deliveryState);
    if (['queued', 'processing'].includes(deliveryState)
      || ['queued', 'processing'].includes(message.status)) {
      processingSlotKeys.add(key);
    }
  }
  return rows.filter((row) => {
    const coordinates = terminalResponseCoordinates(row);
    if (!coordinates) return false;
    const key = coordinatesKey(coordinates);
    // Durable storage is not proof that the currently loaded page contains
    // the reply. A missing slot needs the same repair as a pending slot.
    return processingSlotKeys.has(key)
      || (!agentSlotKeys.has(key)
        && requestKeys.has(`${coordinates.groupId}\u0000${coordinates.requestId}`));
  });
}

import type { CanonicalSessionMessage } from '@/kordi-app/types';
import {
  cloudGroupCanonicalMessageSource,
  cloudGroupReplayKeyForRow,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';

function attachmentIds(values: readonly unknown[] | null | undefined): string[] {
  return (values ?? []).flatMap((value) => {
    const id = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { attachmentId?: unknown }).attachmentId
      : null;
    return typeof id === 'string' && id.trim() ? [id.trim()] : [];
  });
}

/** Attachment ids an agent reply row carries, as its message control reads them. */
function agentReplyAttachmentIds(row: IndexedCloudGroupRow): string[] {
  const message = row.envelope.kind === 'group-message' ? row.envelope.message : null;
  if (!message || message.senderKind !== 'agent') return [];
  return attachmentIds(row.wire.attachments?.length ? row.wire.attachments : message.attachments);
}

/**
 * Agent replies whose loaded row lacks an attachment the stored reply has.
 * The server adds a run's documents to the reply it stores (issue 1808). A
 * row written from an answer without them keeps its source and version, so
 * normal replay skips the stored reply as already applied (issue 1906).
 */
export function cloudGroupAttachmentRepairReplayRows(
  rows: readonly IndexedCloudGroupRow[],
  messages: readonly CanonicalSessionMessage[],
): IndexedCloudGroupRow[] {
  if (messages.length === 0) return [];
  const bySource = new Map<string, CanonicalSessionMessage>();
  for (const message of messages) {
    if (message.sourceTransport === 'cloud-group-agent' && message.sourceEventId) {
      bySource.set(message.sourceEventId, message);
    }
  }
  return rows.filter((row) => {
    const ids = agentReplyAttachmentIds(row);
    if (ids.length === 0) return false;
    const source = cloudGroupCanonicalMessageSource(row.wire, row.envelope);
    const loaded = source ? bySource.get(source.sourceEventId) : undefined;
    if (!loaded) return false;
    const content = loaded.content && typeof loaded.content === 'object' && !Array.isArray(loaded.content)
      ? loaded.content as { attachments?: unknown }
      : {};
    const known = new Set(attachmentIds(Array.isArray(content.attachments) ? content.attachments : []));
    return ids.some((id) => !known.has(id));
  });
}

/** A key of its own per attachment set, so the repair runs once per new document. */
export function cloudGroupAttachmentRepairReplayKey(row: IndexedCloudGroupRow): string {
  return `attachment-repair:${cloudGroupReplayKeyForRow(row)}:${row.wire.messageId}`
    + `:${agentReplyAttachmentIds(row).join(',')}`;
}

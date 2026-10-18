import type { MessageAttachment } from '@/kordi-app/types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * The attachments a stored group message should carry after a synced copy
 * arrives, or null when nothing changes: a local cache path for an
 * attachment it already has, and, for an agent reply, attachments the server
 * added, such as a document the agent created (issue 1808). The Mac that ran
 * the agent stores its reply before the server attaches the documents.
 */
export function mergedGroupMessageAttachments(
  existing: readonly unknown[],
  incoming: readonly MessageAttachment[],
  addMissing: boolean,
): unknown[] | null {
  let changed = false;
  const merged = existing.map((attachment) => {
    const current = record(attachment);
    const cached = typeof current.attachmentId === 'string' && !current.localPath
      ? incoming.find((candidate) => candidate.attachmentId === current.attachmentId && candidate.localPath)
      : undefined;
    if (!cached) return attachment;
    changed = true;
    return { ...current, localPath: cached.localPath };
  });
  if (addMissing) {
    const known = new Set(existing.map((attachment) => record(attachment).attachmentId).filter(Boolean));
    for (const attachment of incoming) {
      if (!attachment.attachmentId || known.has(attachment.attachmentId)) continue;
      known.add(attachment.attachmentId);
      merged.push(attachment);
      changed = true;
    }
  }
  return changed ? merged : null;
}

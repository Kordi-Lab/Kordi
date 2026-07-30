import type {
  AttachmentItem,
} from '@/features/chat/composerController.types';
import type {
  SendCloudMessageAttachmentInput,
} from './authClient';
import {
  cloudGroupControlWithAttachmentReferences,
} from './cloudGroupMessages';
import {
  CloudGroupOutbox,
  type CloudGroupOutboxAttachmentSource,
  type CloudGroupOutboxEntry,
} from './cloudGroupOutbox';

export function cloudGroupOutboxAttachmentSources(
  attachments: readonly AttachmentItem[],
): CloudGroupOutboxAttachmentSource[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    path: attachment.path,
    name: attachment.name,
    kind: attachment.kind,
    formatLabel: attachment.formatLabel ?? null,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
  }));
}

export async function prepareCloudGroupOutboxEntryAttachments({
  outbox,
  entry,
  upload,
}: {
  outbox: CloudGroupOutbox;
  entry: CloudGroupOutboxEntry;
  upload: (
    attachments: CloudGroupOutboxAttachmentSource[],
  ) => Promise<SendCloudMessageAttachmentInput[]>;
}): Promise<CloudGroupOutboxEntry> {
  const pendingAttachments = entry.pendingAttachments ?? [];
  if (pendingAttachments.length === 0) return entry;
  const attachments = await upload(pendingAttachments);
  const envelope = cloudGroupControlWithAttachmentReferences(
    entry.envelope,
    attachments,
  );
  const prepared = await outbox.completeAttachmentUpload(
    entry.canonicalMessageId,
    { envelope, attachments },
  );
  if (!prepared) {
    throw new Error(
      'Cloud group outbox entry disappeared during attachment upload.',
    );
  }
  return prepared;
}

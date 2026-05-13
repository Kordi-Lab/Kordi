import type { AttachmentItem } from '@/features/chat/composerController.types';
import { readDesktopChatAttachment } from '@/lib/desktop';
import type {
  CloudAuthClient,
  CloudMessageAttachment,
  SendCloudMessageAttachmentInput,
} from './authClient';

export function cloudMessageAttachmentToMessageAttachment(attachment: CloudMessageAttachment) {
  return {
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    previewUrl: null,
    downloadUrl: null,
    localPath: null,
    attachmentId: attachment.attachmentId,
  };
}

export async function uploadComposerAttachments({
  token,
  client,
  attachments,
  readAttachment = readDesktopChatAttachment,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'uploadAttachment'>;
  attachments: AttachmentItem[];
  readAttachment?: (path: string) => Promise<number[]>;
}): Promise<SendCloudMessageAttachmentInput[]> {
  const uploaded: SendCloudMessageAttachmentInput[] = [];
  for (const attachment of attachments) {
    const bytes = await readAttachment(attachment.path);
    const mimeType = attachment.mimeType?.trim() || null;
    const blob = new Blob([new Uint8Array(bytes)], mimeType ? { type: mimeType } : undefined);
    const summary = await client.uploadAttachment(token, blob);
    uploaded.push({
      attachmentId: summary.attachmentId,
      name: attachment.name,
      kind: attachment.kind === 'image' ? 'image' : 'file',
      mimeType,
      sizeBytes: attachment.sizeBytes ?? blob.size,
    });
  }
  return uploaded;
}

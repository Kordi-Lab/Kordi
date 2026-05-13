import type { AttachmentItem } from '@/features/chat/composerController.types';
import { readDesktopChatAttachment, storeDesktopChatAttachment } from '@/lib/desktop';
import type {
  CloudAuthClient,
  CloudMessageAttachment,
  SendCloudMessageAttachmentInput,
} from './authClient';

export const CLOUD_ATTACHMENT_AUTO_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;

const cloudAttachmentLocalPathCache = new Map<string, string>();

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

export async function resolveCloudMessageAttachments({
  token,
  client,
  attachments,
  autoDownloadMaxBytes = CLOUD_ATTACHMENT_AUTO_DOWNLOAD_MAX_BYTES,
  storeAttachment = storeDesktopChatAttachment,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'downloadAttachmentContent'>;
  attachments: CloudMessageAttachment[];
  autoDownloadMaxBytes?: number;
  storeAttachment?: (name: string, data: number[]) => Promise<string>;
}) {
  const resolved = [];
  for (const attachment of attachments) {
    const mapped = cloudMessageAttachmentToMessageAttachment(attachment);
    const cachedPath = cloudAttachmentLocalPathCache.get(attachment.attachmentId);
    if (cachedPath) {
      resolved.push({ ...mapped, localPath: cachedPath });
      continue;
    }
    const shouldAutoDownload = typeof mapped.sizeBytes === 'number'
      && mapped.sizeBytes >= 0
      && mapped.sizeBytes <= autoDownloadMaxBytes;
    if (!shouldAutoDownload) {
      resolved.push(mapped);
      continue;
    }
    try {
      const blob = await client.downloadAttachmentContent(token, attachment.attachmentId);
      if (blob.size > autoDownloadMaxBytes) {
        resolved.push(mapped);
        continue;
      }
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const localPath = await storeAttachment(attachment.name || 'attachment.bin', bytes);
      cloudAttachmentLocalPathCache.set(attachment.attachmentId, localPath);
      resolved.push({ ...mapped, localPath });
    } catch {
      resolved.push(mapped);
    }
  }
  return resolved;
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
    cloudAttachmentLocalPathCache.set(summary.attachmentId, attachment.path);
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

import { uploadNativeCloudAttachment } from './cloudAttachmentUpload';
import { normalizedLivePhoto, normalizedLivePhotoFiles } from '@/features/chat/livePhotos';
import { normalizedImagePixelDimensions } from '@/lib/imageDimensions';
import type { AttachmentItem } from '@/features/chat/composerController.types';
import type { CloudSelfAgentSyncOperation } from './cloudSelfAgentForwardSync';
import type { CloudAuthClient, SendCloudMessageAttachmentInput } from './authClient';
import { uploadComposerAttachments } from './cloudComposerAttachments';

export function selfAgentMessageAttachments(content: unknown): AttachmentItem[] {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  const values = (content as { attachments?: unknown }).attachments;
  if (!Array.isArray(values)) return [];
  return values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { id: `missing-${index}`, path: '', name: 'Unavailable attachment', kind: 'file' as const };
    }
    const attachment = value as Record<string, unknown>;
    const path = typeof attachment.localPath === 'string' ? attachment.localPath.trim() : '';

    return {
      id: `local-attachment-${index}`, path,
      attachmentId: typeof attachment.attachmentId === 'string' ? attachment.attachmentId : null,
      subtype: attachment.subtype === 'sticker' || attachment.subtype === 'meme' ? attachment.subtype : null,
      altText: typeof attachment.altText === 'string' ? attachment.altText : null,
      livePhoto: normalizedLivePhoto(attachment.livePhoto), livePhotoFiles: normalizedLivePhotoFiles(attachment.livePhotoFiles),
      ...(normalizedImagePixelDimensions(attachment.widthPixels, attachment.heightPixels) ?? {}),
      name: typeof attachment.name === 'string' ? attachment.name : 'Attachment',
      kind: attachment.kind === 'image' ? 'image' : 'file',
      mimeType: typeof attachment.mimeType === 'string' ? attachment.mimeType : null,
      sizeBytes: typeof attachment.sizeBytes === 'number' ? attachment.sizeBytes : null,
      previewUrl: typeof attachment.previewUrl === 'string' ? attachment.previewUrl : null,
    };
  });
}

export async function uploadSelfAgentMessageAttachments(
  operation: CloudSelfAgentSyncOperation,
  client: Pick<CloudAuthClient, 'sendMessage'> & Partial<Pick<CloudAuthClient, 'uploadAttachment' | 'updateAttachmentPreview'>>,
  token: string,
  accountId?: string,
): Promise<SendCloudMessageAttachmentInput[]> {
  if (!operation.attachments?.length) return [];
  const uploaded: SendCloudMessageAttachmentInput[] = [];
  for (const attachment of operation.attachments) {
    if (attachment.attachmentId) {
      uploaded.push({ attachmentId: attachment.attachmentId, name: attachment.name, kind: attachment.kind,
        subtype: attachment.subtype, altText: attachment.altText, mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes, widthPixels: attachment.widthPixels, heightPixels: attachment.heightPixels,
        ...(attachment.livePhoto ? { livePhoto: attachment.livePhoto } : {}) });
      continue;
    }
    if (!attachment.path) throw new Error('A local message attachment is unavailable.');
    if (!client.uploadAttachment) throw new Error('Attachment upload is unavailable.');
    uploaded.push(...await uploadComposerAttachments({ token, client: { uploadAttachment: client.uploadAttachment.bind(client),
      updateAttachmentPreview: client.updateAttachmentPreview?.bind(client) }, attachments: [attachment],
      nativeUpload: input => uploadNativeCloudAttachment({ ...input, expectedAccountId: accountId }) }));
  }
  return uploaded;
}

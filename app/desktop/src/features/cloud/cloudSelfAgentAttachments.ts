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
      throw new Error('A local message attachment is unavailable.');
    }
    const attachment = value as Record<string, unknown>;
    const path = typeof attachment.localPath === 'string' ? attachment.localPath.trim() : '';
    if (!path) throw new Error('A local message attachment must be downloaded before syncing.');
    return {
      id: `local-attachment-${index}`, path,
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
): Promise<SendCloudMessageAttachmentInput[]> {
  if (!operation.attachments?.length) return [];
  if (!client.uploadAttachment) throw new Error('Attachment upload is unavailable.');
  return uploadComposerAttachments({ token, client: { uploadAttachment: client.uploadAttachment.bind(client),
    updateAttachmentPreview: client.updateAttachmentPreview?.bind(client) }, attachments: operation.attachments });
}

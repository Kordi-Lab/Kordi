import type { CloudMessage } from './authClient';
import type { MessageAttachment } from '@/kordi-app/types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function portable(value: unknown) {
  const a = record(value);
  return { attachmentId: a.attachmentId ?? null, name: a.name, kind: a.kind,
    mimeType: a.mimeType ?? null, sizeBytes: a.sizeBytes ?? null, subtype: a.subtype ?? null,
    widthPixels: a.widthPixels ?? null, heightPixels: a.heightPixels ?? null,
    livePhoto: a.livePhoto ?? null, previewAttachmentId: a.previewAttachmentId ?? null };
}

export function selfAgentAttachmentUpdate(message: CloudMessage, content: unknown) {
  const current = record(content);
  const previous = Array.isArray(current.attachments) ? current.attachments : [];
  if (!Array.isArray(message.attachments)) return { changed: false, content: current };
  const previousVersion = Math.max(typeof current.cloudAttachmentVersion === 'number' ? current.cloudAttachmentVersion : 0,
    typeof current.cloudMessageVersion === 'number' ? current.cloudMessageVersion : 0);
  if (previousVersion > 0 && (message.version == null || message.version < previousVersion)) return { changed: false, content: current };
  const changed = JSON.stringify(previous.map(portable)) !== JSON.stringify(message.attachments.map(portable))
    || (previousVersion > 0 && (message.version ?? 0) > previousVersion);
  const localAttachments = previous.map(record);
  const attachments: MessageAttachment[] = message.attachments.map((attachment, index) => {
    const local = localAttachments.find(value => value.attachmentId === attachment.attachmentId)
      ?? (record(previous[index]).attachmentId ? {} : record(previous[index]));
    return { ...attachment, ...(typeof local.localPath === 'string' ? { localPath: local.localPath } : {}) };
  });
  return { changed, content: { ...current, attachments,
    ...(message.version != null ? { cloudAttachmentVersion: message.version } : {}) } };
}

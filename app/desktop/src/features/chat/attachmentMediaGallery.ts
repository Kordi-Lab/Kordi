import { convertFileSrc } from '@tauri-apps/api/core';

import type { Message, MessageAttachment } from '@/kordi-app/types';
import {
  fittedImageDisplaySize,
  normalizedImagePixelDimensions,
} from '@/lib/imageDimensions';

const INLINE_ATTACHMENT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const ARCHIVE_ATTACHMENT_EXTENSIONS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

function isNativeShell() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function isInternalObjectStoreUrl(value?: string | null) {
  if (!value) return false;
  try {
    return new URL(value).hostname === 'minio.kordi-cloud.svc.cluster.local';
  } catch {
    return value.includes('minio.kordi-cloud.svc.cluster.local');
  }
}

export function attachmentPreviewIdentity(attachment: MessageAttachment) {
  return [
    attachment.attachmentId ?? '',
    attachment.previewAttachmentId ?? '',
    attachment.localPath ?? '',
    attachment.previewUrl ?? '',
    attachment.name ?? '',
    attachment.sizeBytes ?? '',
  ].join(':');
}

export function safeAttachmentPreviewUrl(value?: string | null) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || isInternalObjectStoreUrl(trimmed)) return undefined;
  return trimmed;
}

function attachmentExtension(attachment: MessageAttachment) {
  const candidate = attachment.name || attachment.localPath || '';
  const match = candidate.match(/\.([A-Za-z0-9]+)$/);
  return match?.[1]?.toLowerCase() ?? '';
}

export function isAnimatedGifAttachment(
  attachment: Pick<MessageAttachment, 'name' | 'mimeType'>,
) {
  return attachment.mimeType?.trim().toLowerCase() === 'image/gif'
    || attachment.name.trim().toLowerCase().endsWith('.gif');
}

export function attachmentImageDisplaySize(attachment: MessageAttachment) {
  const dimensions = normalizedImagePixelDimensions(
    attachment.widthPixels,
    attachment.heightPixels,
  );
  if (!dimensions) return null;
  const expressive = attachment.subtype === 'sticker' || isAnimatedGifAttachment(attachment);
  return fittedImageDisplaySize(dimensions, expressive ? 180 : 464, expressive ? 180 : 320);
}

export function isMp4VideoAttachment(attachment: MessageAttachment) {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  return mimeType === 'video/mp4'
    || ((!mimeType || mimeType === 'application/octet-stream') && attachmentExtension(attachment) === 'mp4');
}

export function attachmentsAreOnlyMp4Videos(attachments?: readonly MessageAttachment[] | null) {
  return attachments?.length ? attachments.every(isMp4VideoAttachment) : false;
}

export function playableVideoSource(
  localSource?: string | null,
  remoteSource?: string | null,
  failedSource?: string | null,
) {
  return (localSource !== failedSource ? localSource : null)
    ?? (remoteSource !== failedSource ? remoteSource : null)
    ?? undefined;
}

export function attachmentVideoDisplaySize(
  attachment: Pick<MessageAttachment, 'widthPixels' | 'heightPixels'>,
) {
  const dimensions = normalizedImagePixelDimensions(
    attachment.widthPixels,
    attachment.heightPixels,
  );
  if (!dimensions) return { width: 464, height: 261 };
  return fittedImageDisplaySize(dimensions, 464, 320);
}

function isArchiveAttachment(attachment: MessageAttachment) {
  return ARCHIVE_ATTACHMENT_EXTENSIONS.has(attachmentExtension(attachment));
}

export function isLargeAttachment(attachment: MessageAttachment) {
  return typeof attachment.sizeBytes === 'number' && attachment.sizeBytes > INLINE_ATTACHMENT_PREVIEW_MAX_BYTES;
}

export function shouldPreviewAttachmentInline(attachment: MessageAttachment) {
  return attachment.kind === 'image'
    && !isArchiveAttachment(attachment)
    && (
      !isLargeAttachment(attachment)
      || Boolean(attachment.previewAttachmentId)
      || Boolean(safeAttachmentPreviewUrl(attachment.previewUrl))
    );
}

export function attachmentPreviewUrl(attachment: MessageAttachment) {
  if (!shouldPreviewAttachmentInline(attachment)) return undefined;
  if (isAnimatedGifAttachment(attachment)) {
    if (attachment.localPath && isNativeShell()) {
      try {
        return convertFileSrc(attachment.localPath);
      } catch {
        return undefined;
      }
    }
  }
  const previewUrl = safeAttachmentPreviewUrl(attachment.previewUrl);
  if (previewUrl) return previewUrl;
  if (attachment.localPath && isNativeShell() && !isLargeAttachment(attachment)) {
    try {
      return convertFileSrc(attachment.localPath);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function attachmentVideoUrl(attachment: MessageAttachment) {
  if (!isMp4VideoAttachment(attachment)) return undefined;
  if (attachment.localPath && isNativeShell()) {
    try {
      return convertFileSrc(attachment.localPath);
    } catch {
      return undefined;
    }
  }
  const previewUrl = safeAttachmentPreviewUrl(attachment.previewUrl);
  if (previewUrl && !previewUrl.startsWith('data:image/')) return previewUrl;
  return undefined;
}

export function collectConversationImageAttachments(messages: readonly Message[]) {
  return messages.flatMap((message) => (message.attachments ?? []).filter(shouldPreviewAttachmentInline));
}

export function attachmentMediaGalleryIndex(
  gallery: readonly MessageAttachment[],
  attachment: MessageAttachment,
) {
  const referenceIndex = gallery.indexOf(attachment);
  if (referenceIndex >= 0) return referenceIndex;
  const identity = attachmentPreviewIdentity(attachment);
  return gallery.findIndex((candidate) => attachmentPreviewIdentity(candidate) === identity);
}

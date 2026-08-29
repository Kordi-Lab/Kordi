import type { AttachmentItem, AttachmentItemUpdate } from './composerController.types';
import type { SaveDesktopAttachmentOptions } from './composerController.types';
import { createCompressedImagePreviewDataUrl } from '@/features/cloud/cloudAttachments';
import {
  readDesktopChatAttachment,
  storeDesktopChatAttachmentFile,
  type DesktopStoredChatAttachment,
} from '@/lib/desktop';
import {
  imagePixelDimensionsFromUrl,
  normalizedImagePixelDimensions,
} from '@/lib/imageDimensions';
import { isSupportedMemeImage } from './memeAttachments';

export const CHAT_COMPOSER_ATTACHMENTS_STORAGE_KEY = 'kordi.chatComposerAttachments.v1';
export const MAX_CHAT_ATTACHMENT_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

const GENERIC_IMAGE_NAMES = new Set(['image', 'img', 'clipboard', 'pasted-image', 'pasted image', 'screenshot']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const MAX_EAGER_IMAGE_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_IN_MEMORY_ATTACHMENT_BYTES = 64 * 1024 * 1024;

type ComposerAttachmentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type StoredComposerAttachment = {
  id: string;
  name: string;
  path: string;
  kind: AttachmentItem['kind'];
  formatLabel?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  widthPixels?: number | null;
  heightPixels?: number | null;
  subtype?: AttachmentItem['subtype'];
  altText?: string | null;
  memeRightsConfirmed?: boolean;
};

function extensionFromName(name: string) {
  const match = name.trim().match(/\.([A-Za-z0-9]+)$/);
  return match?.[1]?.toLowerCase() ?? '';
}

function baseNameWithoutExtension(name: string) {
  return name.trim().replace(/\.[A-Za-z0-9]+$/, '').trim();
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function screenshotName(extension: string, timestampMs: number) {
  const date = new Date(timestampMs);
  const safeExtension = IMAGE_EXTENSIONS.has(extension.toLowerCase()) ? extension.toLowerCase() : 'png';
  return `Screenshot ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}.${safeExtension}`;
}

function isGenericImageName(name: string) {
  const trimmed = name.trim();
  const extension = extensionFromName(trimmed);
  if (!IMAGE_EXTENSIONS.has(extension)) return false;

  const baseName = baseNameWithoutExtension(trimmed).toLowerCase();
  if (GENERIC_IMAGE_NAMES.has(baseName)) return true;
  if (/^image[-_\s]?\d*$/.test(baseName)) return true;
  if (/^screenshot[-_\s]?\d*$/.test(baseName)) return true;
  return /^pi-clipboard-[a-f0-9-]{16,}$/i.test(baseName);
}

export function displayAttachmentName(name: string, kind: AttachmentItem['kind']) {
  const trimmed = name.trim() || (kind === 'image' ? 'Image attachment' : 'Attachment');
  if (kind === 'image' && isGenericImageName(trimmed)) {
    return 'Image attachment';
  }
  return trimmed;
}

export function friendlyAttachmentName(name: string, kind: AttachmentItem['kind'], timestampMs = Date.now()) {
  const trimmed = name.trim() || (kind === 'image' ? 'image.png' : 'attachment.bin');
  if (kind !== 'image' || !isGenericImageName(trimmed)) {
    return trimmed;
  }

  return screenshotName(extensionFromName(trimmed), timestampMs);
}

export function attachmentFormatLabel(name: string, mimeType?: string) {
  return name.split('.').pop()?.trim().toUpperCase()
    || mimeType?.split('/').pop()?.trim().toUpperCase()
    || 'FILE';
}

export function composerEditedImageOutput(
  attachment: Pick<AttachmentItem, 'mimeType' | 'name'>,
) {
  const extension = attachment.name.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? '';
  const declaredMimeType = attachment.mimeType === 'image/jpeg'
    || attachment.mimeType === 'image/png'
    || attachment.mimeType === 'image/webp'
    ? attachment.mimeType
    : null;
  const mimeType = declaredMimeType
    ?? (extension === 'jpg' || extension === 'jpeg'
      ? 'image/jpeg'
      : extension === 'webp' ? 'image/webp' : 'image/png');
  const acceptedExtensions = mimeType === 'image/jpeg' ? ['jpg', 'jpeg'] : [mimeType.split('/')[1]];
  if (acceptedExtensions.includes(extension)) return { mimeType, name: attachment.name };
  const baseName = attachment.name.replace(/\.[A-Za-z0-9]+$/, '') || 'Edited image';
  return { mimeType, name: `${baseName}.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]}` };
}

export type ComposerImageCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ComposerImageCropHandle =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'right'
  | 'bottom-right'
  | 'bottom'
  | 'bottom-left'
  | 'left';

export const COMPOSER_IMAGE_FULL_CROP: ComposerImageCropRect = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

export function movedComposerImageCrop(
  crop: ComposerImageCropRect,
  dx: number,
  dy: number,
): ComposerImageCropRect {
  return {
    ...crop,
    x: Math.min(Math.max(0, crop.x + dx), 1 - crop.width),
    y: Math.min(Math.max(0, crop.y + dy), 1 - crop.height),
  };
}

export function resizedComposerImageCrop(
  crop: ComposerImageCropRect,
  handle: ComposerImageCropHandle,
  dx: number,
  dy: number,
  minimumSide = 0.12,
): ComposerImageCropRect {
  let left = crop.x;
  let top = crop.y;
  let right = crop.x + crop.width;
  let bottom = crop.y + crop.height;
  if (handle.includes('left')) left = Math.min(Math.max(0, left + dx), right - minimumSide);
  else if (handle.includes('right')) right = Math.max(Math.min(1, right + dx), left + minimumSide);
  if (handle.includes('top')) top = Math.min(Math.max(0, top + dy), bottom - minimumSide);
  else if (handle.includes('bottom')) bottom = Math.max(Math.min(1, bottom + dy), top + minimumSide);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function composerImageCropPixels(
  crop: ComposerImageCropRect,
  width: number,
  height: number,
) {
  const x = Math.round(crop.x * width);
  const y = Math.round(crop.y * height);
  return {
    x,
    y,
    width: Math.max(1, Math.round((crop.x + crop.width) * width) - x),
    height: Math.max(1, Math.round((crop.y + crop.height) * height) - y),
  };
}

export function composerAttachmentNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').pop()?.trim() || 'attachment';
}

export function composerAttachmentKindFromName(name: string): AttachmentItem['kind'] {
  const extension = name.split('.').pop()?.trim().toLowerCase();
  return extension && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension)
    ? 'image'
    : 'file';
}

type ComposerPathPreviewMetadata = Pick<AttachmentItem, 'name' | 'kind' | 'mimeType' | 'sizeBytes'>;
type ComposerPathPreviewGenerator = (storedPath: string, metadata: ComposerPathPreviewMetadata) => Promise<string | null | undefined>;

async function createComposerAttachmentPathPreviewUrl(storedPath: string, metadata: ComposerPathPreviewMetadata) {
  if (metadata.kind !== 'image') return null;
  try {
    const bytes = await readDesktopChatAttachment(storedPath);
    const mimeType = metadata.mimeType?.trim() || null;
    const blob = new Blob([new Uint8Array(bytes)], mimeType ? { type: mimeType } : undefined);
    return await createCompressedImagePreviewDataUrl(blob);
  } catch {
    return null;
  }
}

export async function composerAttachmentItemFromStoredPath({
  sourcePath,
  stored,
  displayName: preferredDisplayName,
  createPreviewUrl = createComposerAttachmentPathPreviewUrl,
}: {
  sourcePath: string;
  stored: Pick<DesktopStoredChatAttachment, 'path' | 'kind' | 'mimeType' | 'formatLabel' | 'sizeBytes'> & { name?: string | null };
  displayName?: string;
  createPreviewUrl?: ComposerPathPreviewGenerator;
}): Promise<AttachmentItem> {
  const rawName = composerAttachmentNameFromPath(sourcePath);
  const kindFromName = composerAttachmentKindFromName(rawName);
  const displayName = preferredDisplayName?.trim() || stored.name?.trim() || friendlyAttachmentName(rawName, kindFromName);
  const kind = stored.kind === 'image' ? ('image' as const) : ('file' as const);
  const metadata = { name: displayName, kind, mimeType: stored.mimeType ?? undefined, sizeBytes: stored.sizeBytes ?? undefined };
  const previewUrl = kind === 'image'
    && (metadata.sizeBytes ?? 0) <= MAX_EAGER_IMAGE_PREVIEW_BYTES
    ? await createPreviewUrl(stored.path, metadata)
    : null;
  const dimensions = kind === 'image'
    ? await imagePixelDimensionsFromUrl(previewUrl)
    : null;
  return {
    id: `${displayName}-${stored.path}`,
    name: displayName,
    path: stored.path,
    kind,
    mimeType: stored.mimeType ?? undefined,
    formatLabel: stored.formatLabel ?? attachmentFormatLabel(displayName, stored.mimeType ?? undefined),
    sizeBytes: stored.sizeBytes ?? undefined,
    ...(dimensions ?? {}),
    ...(previewUrl ? { previewUrl } : {}),
  };
}

export async function composerAttachmentItemFromFile(
  file: File,
  options: SaveDesktopAttachmentOptions = {},
): Promise<AttachmentItem> {
  if (file.size > MAX_CHAT_ATTACHMENT_SIZE_BYTES) {
    throw new Error('Attachments must be 2 GiB or smaller.');
  }
  if (file.size > MAX_IN_MEMORY_ATTACHMENT_BYTES && file.type?.startsWith('image/')) {
    throw new Error('Use Files and folders to attach images larger than 64 MiB.');
  }
  const mimeType = file.type || undefined;
  const kind = file.type.startsWith('image/') ? ('image' as const) : ('file' as const);
  const name = friendlyAttachmentName(file.name || 'attachment.bin', kind);
  const subtype = options.subtype === 'meme' ? 'meme' : null;
  if (subtype && !isSupportedMemeImage({ kind, mimeType, name })) {
    throw new Error('Memes must be PNG, JPEG, GIF, or WebP images.');
  }
  const stored = await storeDesktopChatAttachmentFile(file, name);
  const path = stored.path;
  const previewUrl = kind === 'image' || mimeType === 'video/mp4'
    ? URL.createObjectURL(file)
    : undefined;
  const dimensions = kind === 'image'
    ? await imagePixelDimensionsFromUrl(previewUrl)
    : null;
  return {
    id: `${name}-${path}`,
    name,
    path,
    localPath: path,
    kind,
    mimeType,
    formatLabel: attachmentFormatLabel(name, mimeType),
    previewUrl,
    sizeBytes: file.size,
    ...(dimensions ?? {}),
    ...(subtype ? { subtype, altText: '', memeRightsConfirmed: false } : {}),
  };
}

export function updatedComposerAttachment(
  attachment: AttachmentItem,
  update: AttachmentItemUpdate,
): AttachmentItem {
  if ('path' in update) {
    if (attachment.previewUrl?.startsWith('blob:') && attachment.previewUrl !== update.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
    return update;
  }
  if (update.subtype === 'meme') {
    return {
      ...attachment,
      subtype: 'meme',
      altText: update.altText ?? attachment.altText ?? '',
      memeRightsConfirmed: update.memeRightsConfirmed ?? attachment.memeRightsConfirmed ?? false,
    };
  }
  const { subtype: _subtype, altText: _altText, memeRightsConfirmed: _rights, ...ordinaryAttachment } = attachment;
  return ordinaryAttachment;
}

function storedAttachmentFromRecord(record: Record<string, unknown>): AttachmentItem | null {
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const path = typeof record.path === 'string' ? record.path.trim() : '';
  const kind = record.kind === 'image' || record.kind === 'file' ? record.kind : null;
  if (!id || !name || !path || !kind) return null;

  const formatLabel = typeof record.formatLabel === 'string' ? record.formatLabel : null;
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType : null;
  const sizeBytes = typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) ? record.sizeBytes : null;
  const dimensions = normalizedImagePixelDimensions(record.widthPixels, record.heightPixels);
  const subtype = kind === 'image' && (record.subtype === 'meme' || record.subtype === 'sticker')
    ? record.subtype
    : null;
  const altText = typeof record.altText === 'string' ? record.altText : null;

  return {
    id,
    name,
    path,
    kind,
    formatLabel,
    mimeType,
    localPath: path,
    previewUrl: null,
    sizeBytes,
    ...(dimensions ?? {}),
    ...(subtype === 'sticker'
      ? { subtype }
      : subtype === 'meme' ? {
          subtype,
          altText,
          memeRightsConfirmed: record.memeRightsConfirmed === true,
        } : {}),
  };
}

export function parseStoredComposerAttachments(raw: string | null | undefined): AttachmentItem[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const attachment = storedAttachmentFromRecord(item as Record<string, unknown>);
      return attachment ? [attachment] : [];
    });
  } catch {
    return [];
  }
}

export function serializeStoredComposerAttachments(attachments: AttachmentItem[]) {
  const serializable: StoredComposerAttachment[] = attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
    kind: attachment.kind,
    formatLabel: attachment.formatLabel ?? null,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    widthPixels: attachment.widthPixels ?? null,
    heightPixels: attachment.heightPixels ?? null,
    subtype: attachment.subtype ?? null,
    altText: attachment.altText ?? null,
    memeRightsConfirmed: attachment.memeRightsConfirmed === true,
  }));
  return JSON.stringify(serializable);
}

function browserStorage(): ComposerAttachmentStorage | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

export function readStoredComposerAttachments(storage: ComposerAttachmentStorage | null = browserStorage()) {
  return parseStoredComposerAttachments(storage?.getItem(CHAT_COMPOSER_ATTACHMENTS_STORAGE_KEY));
}

export function writeStoredComposerAttachments(attachments: AttachmentItem[], storage: ComposerAttachmentStorage | null = browserStorage()) {
  if (!storage) return;
  if (attachments.length === 0) {
    storage.removeItem(CHAT_COMPOSER_ATTACHMENTS_STORAGE_KEY);
    return;
  }
  storage.setItem(CHAT_COMPOSER_ATTACHMENTS_STORAGE_KEY, serializeStoredComposerAttachments(attachments));
}

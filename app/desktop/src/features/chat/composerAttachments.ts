import type { AttachmentItem } from './composerController.types';
import type { SaveDesktopAttachmentOptions } from './composerController.types';
import { createCompressedImagePreviewDataUrl } from '@/features/cloud/cloudAttachments';
import {
  readDesktopChatAttachment,
  storeDesktopChatAttachment,
  type DesktopStoredChatAttachment,
} from '@/lib/desktop';
import { isSupportedMemeImage } from './memeAttachments';

export const CHAT_COMPOSER_ATTACHMENTS_STORAGE_KEY = 'kordi.chatComposerAttachments.v1';

const GENERIC_IMAGE_NAMES = new Set(['image', 'img', 'clipboard', 'pasted-image', 'pasted image', 'screenshot']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

type ComposerAttachmentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type StoredComposerAttachment = {
  id: string;
  name: string;
  path: string;
  kind: AttachmentItem['kind'];
  formatLabel?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
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
  const previewUrl = kind === 'image' ? await createPreviewUrl(stored.path, metadata) : null;
  return {
    id: `${displayName}-${stored.path}`,
    name: displayName,
    path: stored.path,
    kind,
    mimeType: stored.mimeType ?? undefined,
    formatLabel: stored.formatLabel ?? attachmentFormatLabel(displayName, stored.mimeType ?? undefined),
    sizeBytes: stored.sizeBytes ?? undefined,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

export async function composerAttachmentItemFromFile(
  file: File,
  options: SaveDesktopAttachmentOptions = {},
): Promise<AttachmentItem> {
  const mimeType = file.type || undefined;
  const kind = file.type.startsWith('image/') ? ('image' as const) : ('file' as const);
  const name = friendlyAttachmentName(file.name || 'attachment.bin', kind);
  const subtype = options.subtype === 'meme' ? 'meme' : null;
  if (subtype && !isSupportedMemeImage({ kind, mimeType, name })) {
    throw new Error('Memes must be PNG, JPEG, GIF, or WebP images.');
  }
  const path = await storeDesktopChatAttachment(name, Array.from(new Uint8Array(await file.arrayBuffer())));
  return {
    id: `${name}-${path}`,
    name,
    path,
    kind,
    mimeType,
    formatLabel: attachmentFormatLabel(name, mimeType),
    previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
    sizeBytes: file.size,
    ...(subtype ? { subtype, altText: '', memeRightsConfirmed: false } : {}),
  };
}

export function updatedComposerAttachmentMetadata(
  attachment: AttachmentItem,
  update: Pick<AttachmentItem, 'subtype' | 'altText' | 'memeRightsConfirmed'>,
): AttachmentItem {
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
  const subtype = record.subtype === 'meme' && kind === 'image' ? 'meme' : null;
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
    ...(subtype ? {
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

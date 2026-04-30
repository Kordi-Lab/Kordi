import type { AttachmentItem } from './composerController.types';

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

function storedAttachmentFromRecord(record: Record<string, unknown>): AttachmentItem | null {
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const path = typeof record.path === 'string' ? record.path.trim() : '';
  const kind = record.kind === 'image' || record.kind === 'file' ? record.kind : null;
  if (!id || !name || !path || !kind) return null;

  const formatLabel = typeof record.formatLabel === 'string' ? record.formatLabel : null;
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType : null;
  const sizeBytes = typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) ? record.sizeBytes : null;

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

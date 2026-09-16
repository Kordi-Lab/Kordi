import { convertFileSrc } from '@tauri-apps/api/core';

import type { AttachmentItem } from '@/features/chat/composerController.types';
import type { CloudAuthClient, CloudExpressiveMediaItem } from '@/features/cloud/authClient';
import { readDesktopChatAttachment, storeDesktopChatAttachment } from '@/lib/desktop';
import {
  imagePixelDimensionsFromBlob,
  normalizedImagePixelDimensions,
} from '@/lib/imageDimensions';
import {
  EXPRESSIVE_MEDIA_MAX_BYTES, GIF_MIME_TYPES, STICKER_MIME_TYPES, compressStickerFile,
  expressiveMediaFileError, expressiveMediaKindForFile, fileExtension,
  type CompressStickerFile, type ExpressiveMediaKind,
} from './expressiveMediaFile';
import { EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY } from './expressiveMediaAttachmentKind';

const EXPRESSIVE_MEDIA_LIBRARY_MIGRATION_KEY = 'kordi.expressiveMediaLibrary.migratedAccount.v1';
export { EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY, expressiveMediaLibraryKindForAttachment } from './expressiveMediaAttachmentKind';
export {
  EXPRESSIVE_MEDIA_MAX_BYTES, GIF_FILE_ACCEPT, STICKER_FILE_ACCEPT,
  expressiveMediaFileError, expressiveMediaKindForFile, type ExpressiveMediaKind,
} from './expressiveMediaFile';

export type ProviderMediaSelection = {
  providerMediaId: string;
  mediaKind: ExpressiveMediaKind;
  title: string;
  mediaUrl: string;
};

export type ExpressiveMediaLibraryItem = {
  id: string;
  kind: ExpressiveMediaKind;
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  widthPixels?: number;
  heightPixels?: number;
  createdAtMs: number;
  cloudItemId?: string;
  attachmentId?: string;
};

type ExpressiveMediaStorage = Pick<Storage, 'getItem' | 'setItem'>;
type StoreMediaFile = (name: string, data: number[]) => Promise<string>;
type FetchMediaFile = (
  input: string,
  init?: Pick<RequestInit, 'redirect'>,
) => Promise<Pick<Response, 'ok' | 'blob'>>;

type ExpressiveMediaSource = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  data: number[];
  widthPixels?: number | null;
  heightPixels?: number | null;
  attachmentId?: string | null;
};

type ExpressiveMediaCloudClient = Pick<
  CloudAuthClient,
  'downloadAttachmentContent' | 'listExpressiveMedia' | 'saveExpressiveMedia' | 'uploadAttachment'
>;

type ExpressiveMediaSyncOptions = {
  accountId: string;
  token: string;
  storage?: ExpressiveMediaStorage | null;
  client: ExpressiveMediaCloudClient;
  readFile?: (path: string) => Promise<number[]>;
  storeFile?: StoreMediaFile;
};

const expressiveMediaSyncs = new Map<string, Promise<ExpressiveMediaLibraryItem[]>>();
const expressiveMediaLibraryListeners = new Set<() => void>();
let expressiveMediaLibraryRevision = 0;

export function subscribeExpressiveMediaLibrary(listener: () => void) {
  expressiveMediaLibraryListeners.add(listener);
  return () => expressiveMediaLibraryListeners.delete(listener);
}

export function expressiveMediaLibrarySnapshot() {
  return expressiveMediaLibraryRevision;
}

function browserStorage(): ExpressiveMediaStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function expressiveMediaLibraryStorageKey(accountId?: string | null) {
  const normalizedAccountId = accountId?.trim();
  return normalizedAccountId
    ? `${EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY}.${encodeURIComponent(normalizedAccountId)}`
    : EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY;
}

function migrateLegacyLibrary(
  storage: ExpressiveMediaStorage,
  accountId?: string | null,
) {
  const normalizedAccountId = accountId?.trim();
  if (!normalizedAccountId) return;
  const scopedKey = expressiveMediaLibraryStorageKey(normalizedAccountId);
  if (storage.getItem(EXPRESSIVE_MEDIA_LIBRARY_MIGRATION_KEY) !== null) return;
  const legacyValue = storage.getItem(EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY);
  if (legacyValue === null) return;
  if (storage.getItem(scopedKey) === null) {
    storage.setItem(scopedKey, legacyValue);
  }
  storage.setItem(EXPRESSIVE_MEDIA_LIBRARY_MIGRATION_KEY, normalizedAccountId);
}

function formatLabel(name: string, mimeType: string) {
  return fileExtension(name).toUpperCase()
    || mimeType.split('/').pop()?.toUpperCase()
    || 'IMAGE';
}

function parsedLibraryItem(value: unknown): ExpressiveMediaLibraryItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === 'sticker' || record.kind === 'gif' ? record.kind : null;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const path = typeof record.path === 'string' ? record.path.trim() : '';
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType.trim() : '';
  const sizeBytes = typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes)
    ? record.sizeBytes
    : 0;
  const createdAtMs = typeof record.createdAtMs === 'number' && Number.isFinite(record.createdAtMs)
    ? record.createdAtMs
    : 0;
  const cloudItemId = typeof record.cloudItemId === 'string' ? record.cloudItemId.trim() : '';
  const attachmentId = typeof record.attachmentId === 'string' ? record.attachmentId.trim() : '';
  const dimensions = normalizedImagePixelDimensions(record.widthPixels, record.heightPixels);
  if (!kind || !id || !name || !path || !mimeType) return null;
  return {
    id,
    kind,
    name,
    path,
    mimeType,
    sizeBytes,
    createdAtMs,
    ...(dimensions ?? {}),
    ...(cloudItemId ? { cloudItemId } : {}),
    ...(attachmentId ? { attachmentId } : {}),
  };
}

export function readExpressiveMediaLibrary(
  storage: ExpressiveMediaStorage | null = browserStorage(),
  accountId?: string | null,
): ExpressiveMediaLibraryItem[] {
  if (!storage) return [];
  try {
    migrateLegacyLibrary(storage, accountId);
    const parsed: unknown = JSON.parse(
      storage.getItem(expressiveMediaLibraryStorageKey(accountId)) ?? '[]',
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((value) => {
        const item = parsedLibraryItem(value);
        return item ? [item] : [];
      })
      .sort((left, right) => right.createdAtMs - left.createdAtMs);
  } catch {
    return [];
  }
}

export function writeExpressiveMediaLibrary(
  items: ExpressiveMediaLibraryItem[],
  storage: ExpressiveMediaStorage | null = browserStorage(),
  accountId?: string | null,
) {
  if (!storage) return;
  storage.setItem(expressiveMediaLibraryStorageKey(accountId), JSON.stringify(items));
  expressiveMediaLibraryRevision += 1;
  expressiveMediaLibraryListeners.forEach((listener) => listener());
}

export async function waitForExpressiveMediaLibrarySync(accountId?: string) {
  if (accountId) await expressiveMediaSyncs.get(accountId);
}

export async function addMediaToExpressiveMediaLibrary(
  media: ExpressiveMediaSource,
  kind: ExpressiveMediaKind,
  options: {
    storage?: ExpressiveMediaStorage | null;
    storeFile?: StoreMediaFile;
    now?: () => number;
    accountId?: string | null;
  } = {},
) {
  if (media.sizeBytes > EXPRESSIVE_MEDIA_MAX_BYTES) {
    if (media.mimeType === 'image/gif' || fileExtension(media.name) === 'gif') {
      throw new Error('Choose an animated GIF smaller than 2 MB so its animation can be preserved.');
    }
    throw new Error('Choose media smaller than 2 MB.');
  }
  const validationError = expressiveMediaFileError(
    { name: media.name, type: media.mimeType },
    kind,
  );
  if (validationError) throw new Error(validationError);
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const path = await (options.storeFile ?? storeDesktopChatAttachment)(media.name, media.data);
  const dimensions = normalizedImagePixelDimensions(media.widthPixels, media.heightPixels)
    ?? await imagePixelDimensionsFromBlob(new Blob([new Uint8Array(media.data)], { type: media.mimeType }));
  const addition: ExpressiveMediaLibraryItem = {
    id: `${kind}:${path}`,
    kind,
    name: media.name,
    path,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    createdAtMs: (options.now ?? Date.now)(),
    ...(dimensions ?? {}),
    ...(media.attachmentId?.trim() ? { attachmentId: media.attachmentId.trim() } : {}),
  };
  const existing = readExpressiveMediaLibrary(storage, options.accountId);
  const next = [addition, ...existing.filter((item) => item.path !== path)];
  writeExpressiveMediaLibrary(next, storage, options.accountId);
  return addition;
}

export async function addFilesToExpressiveMediaLibrary(
  files: File[],
  kind: ExpressiveMediaKind,
  options: {
    storage?: ExpressiveMediaStorage | null;
    storeFile?: StoreMediaFile;
    now?: () => number;
    accountId?: string | null;
    compressSticker?: CompressStickerFile;
  } = {},
) {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const storeFile = options.storeFile ?? storeDesktopChatAttachment;
  const now = options.now ?? Date.now;
  const existing = readExpressiveMediaLibrary(storage, options.accountId);
  const additions: ExpressiveMediaLibraryItem[] = [];

  for (const file of files) {
    const validationError = expressiveMediaFileError(file, kind);
    if (validationError) throw new Error(validationError);
    const sourceKind = expressiveMediaKindForFile(file);
    if (sourceKind === 'gif' && file.size > EXPRESSIVE_MEDIA_MAX_BYTES) {
      throw new Error('Choose an animated GIF smaller than 2 MB so its animation can be preserved.');
    }
    const prepared = kind === 'sticker'
      && sourceKind !== 'gif'
      ? await (options.compressSticker ?? compressStickerFile)(file)
      : file;
    const mimeType = prepared.type.trim().toLocaleLowerCase()
      || (kind === 'gif' ? 'image/gif' : `image/${fileExtension(prepared.name)}`);
    const data = Array.from(new Uint8Array(await prepared.arrayBuffer()));
    additions.push(await addMediaToExpressiveMediaLibrary({
      name: prepared.name,
      mimeType,
      sizeBytes: prepared.size,
      data,
    }, kind, { storage: null, storeFile, now }));
  }

  const addedPaths = new Set(additions.map((item) => item.path));
  const next = [
    ...additions,
    ...existing.filter((item) => !addedPaths.has(item.path)),
  ];
  writeExpressiveMediaLibrary(next, storage, options.accountId);
  return next;
}

export function synchronizeExpressiveMediaLibrary(
  options: ExpressiveMediaSyncOptions,
): Promise<ExpressiveMediaLibraryItem[]> {
  const accountId = options.accountId.trim();
  const activeSync = expressiveMediaSyncs.get(accountId);
  if (activeSync) return activeSync;

  const sync = performExpressiveMediaLibrarySync({ ...options, accountId });
  expressiveMediaSyncs.set(accountId, sync);
  const clearSync = () => {
    if (expressiveMediaSyncs.get(accountId) === sync) expressiveMediaSyncs.delete(accountId);
  };
  void sync.then(clearSync, clearSync);
  return sync;
}

async function performExpressiveMediaLibrarySync(
  options: ExpressiveMediaSyncOptions,
): Promise<ExpressiveMediaLibraryItem[]> {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  let localItems = readExpressiveMediaLibrary(storage, options.accountId);
  let remoteItems: CloudExpressiveMediaItem[];
  try {
    remoteItems = await options.client.listExpressiveMedia(options.token);
  } catch {
    return localItems;
  }

  const remoteByAttachmentId = new Map(
    remoteItems.map((item) => [item.attachmentId, item]),
  );
  const remoteByItemId = new Map(remoteItems.map((item) => [item.itemId, item]));
  const readFile = options.readFile ?? readDesktopChatAttachment;
  for (const localItem of localItems) {
    try {
      if (localItem.cloudItemId && !remoteByItemId.has(localItem.cloudItemId)) {
        localItems = readExpressiveMediaLibrary(storage, options.accountId)
          .filter((item) => item.id !== localItem.id);
        writeExpressiveMediaLibrary(localItems, storage, options.accountId);
        continue;
      }
      let cloudItem = localItem.cloudItemId
        ? remoteByItemId.get(localItem.cloudItemId)
        : localItem.attachmentId
        ? remoteByAttachmentId.get(localItem.attachmentId)
        : undefined;
      let attachmentId = localItem.attachmentId;
      if (!cloudItem) {
        if (!attachmentId) {
          const data = await readFile(localItem.path);
          const uploaded = await options.client.uploadAttachment(
            options.token,
            new Blob([new Uint8Array(data)], { type: localItem.mimeType }),
          );
          attachmentId = uploaded.attachmentId;
          localItems = readExpressiveMediaLibrary(storage, options.accountId).map((item) => (
            item.id === localItem.id ? { ...item, attachmentId } : item
          ));
          writeExpressiveMediaLibrary(localItems, storage, options.accountId);
        }
        cloudItem = await options.client.saveExpressiveMedia(options.token, {
          attachmentId,
          kind: localItem.kind,
          name: localItem.name,
        });
        remoteByAttachmentId.set(cloudItem.attachmentId, cloudItem);
        remoteByItemId.set(cloudItem.itemId, cloudItem);
      }
      localItems = readExpressiveMediaLibrary(storage, options.accountId).map((item) => (
        item.id === localItem.id
          ? {
            ...item,
            cloudItemId: cloudItem.itemId,
            attachmentId: cloudItem.attachmentId,
            kind: cloudItem.kind,
            name: cloudItem.name,
            mimeType: cloudItem.mimeType,
            sizeBytes: cloudItem.sizeBytes,
          }
          : item
      ));
      writeExpressiveMediaLibrary(localItems, storage, options.accountId);
    } catch {
      // Preserve the local item and retry it the next time the picker opens.
    }
  }

  localItems = readExpressiveMediaLibrary(storage, options.accountId);
  const localAttachmentIds = new Set(localItems.flatMap((item) => (
    item.attachmentId ? [item.attachmentId] : []
  )));
  for (const cloudItem of remoteByAttachmentId.values()) {
    if (localAttachmentIds.has(cloudItem.attachmentId)) continue;
    try {
      const blob = await options.client.downloadAttachmentContent(
        options.token,
        cloudItem.attachmentId,
      );
      const data = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const dimensions = await imagePixelDimensionsFromBlob(blob);
      const path = await (options.storeFile ?? storeDesktopChatAttachment)(cloudItem.name, data);
      localItems = readExpressiveMediaLibrary(storage, options.accountId);
      if (localItems.some((item) => item.attachmentId === cloudItem.attachmentId)) {
        localAttachmentIds.add(cloudItem.attachmentId);
        continue;
      }
      const createdAtMs = Date.parse(cloudItem.createdAt);
      localItems.push({
        id: cloudItem.itemId,
        cloudItemId: cloudItem.itemId,
        attachmentId: cloudItem.attachmentId,
        kind: cloudItem.kind,
        name: cloudItem.name,
        path,
        mimeType: cloudItem.mimeType,
        sizeBytes: data.length,
        ...(dimensions ?? {}),
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
      });
      localAttachmentIds.add(cloudItem.attachmentId);
      writeExpressiveMediaLibrary(localItems, storage, options.accountId);
    } catch {
      // Keep the rest of the library usable if one item cannot be downloaded.
    }
  }

  localItems = readExpressiveMediaLibrary(storage, options.accountId);
  localItems.sort((left, right) => right.createdAtMs - left.createdAtMs);
  writeExpressiveMediaLibrary(localItems, storage, options.accountId);
  return localItems;
}

export function expressiveMediaPreviewUrl(item: ExpressiveMediaLibraryItem) {
  return convertFileSrc(item.path);
}

export function expressiveMediaAttachment(item: ExpressiveMediaLibraryItem): AttachmentItem {
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    kind: 'image',
    ...(item.kind === 'sticker' ? { subtype: 'sticker' as const } : {}),
    expressiveMedia: true,
    mimeType: item.mimeType,
    formatLabel: formatLabel(item.name, item.mimeType),
    previewUrl: expressiveMediaPreviewUrl(item),
    sizeBytes: item.sizeBytes,
    widthPixels: item.widthPixels ?? null,
    heightPixels: item.heightPixels ?? null,
  };
}

export async function providerMediaAttachment(
  selection: ProviderMediaSelection,
  options: {
    fetchFile?: FetchMediaFile;
    storeFile?: StoreMediaFile;
  } = {},
): Promise<AttachmentItem> {
  let mediaUrl: URL;
  try {
    mediaUrl = new URL(selection.mediaUrl);
  } catch {
    throw new Error('That result does not use a trusted media URL. Try another result.');
  }
  if (mediaUrl.protocol !== 'https:' || mediaUrl.hostname !== 'upload.wikimedia.org') {
    throw new Error('That result does not use a trusted media URL. Try another result.');
  }

  const response = await (options.fetchFile ?? fetch)(selection.mediaUrl, { redirect: 'error' });
  if (!response.ok) throw new Error('Unable to download that media. Try another result.');
  const blob = await response.blob();
  const mimeType = blob.type.trim().toLocaleLowerCase();
  const allowedMimeTypes = selection.mediaKind === 'gif'
    ? GIF_MIME_TYPES
    : STICKER_MIME_TYPES;
  if (!allowedMimeTypes.has(mimeType)) {
    throw new Error('That result is not a supported image. Try another result.');
  }
  if (blob.size > EXPRESSIVE_MEDIA_MAX_BYTES) {
    throw new Error('That result is larger than the 2 MB attachment limit. Try another result.');
  }
  const safeTitle = selection.title.trim().replace(/[^A-Za-z0-9 _-]+/g, '').trim();
  const extension = mimeType === 'image/webp'
    ? 'webp'
    : mimeType === 'image/png'
      ? 'png'
      : mimeType === 'image/jpeg'
        ? 'jpg'
        : 'gif';
  const fallbackTitle = selection.mediaKind === 'sticker' ? 'Public sticker' : 'Public GIF';
  const name = `${safeTitle || fallbackTitle}.${extension}`;
  const data = Array.from(new Uint8Array(await blob.arrayBuffer()));
  const path = await (options.storeFile ?? storeDesktopChatAttachment)(name, data);
  const item: ExpressiveMediaLibraryItem = {
    id: `provider:${selection.providerMediaId}:${path}`,
    kind: selection.mediaKind,
    name,
    path,
    mimeType,
    sizeBytes: blob.size,
    ...((await imagePixelDimensionsFromBlob(blob)) ?? {}),
    createdAtMs: Date.now(),
  };
  return expressiveMediaAttachment(item);
}

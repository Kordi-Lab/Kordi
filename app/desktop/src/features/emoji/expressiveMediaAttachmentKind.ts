import type { ExpressiveMediaKind } from './expressiveMediaFile';

export const EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY = 'kordi.expressiveMediaLibrary.v1';

type ExpressiveMediaStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'key' | 'length'>>;

function browserStorage(): ExpressiveMediaStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function expressiveMediaLibraryKindForAttachment(
  attachment: { name: string; mimeType?: string | null; sizeBytes?: number | null },
  storage: ExpressiveMediaStorage | null = browserStorage(),
): ExpressiveMediaKind | null {
  if (!storage || !Number.isFinite(attachment.sizeBytes)) return null;
  const keys = new Set([EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY]);
  if (typeof storage.key === 'function' && typeof storage.length === 'number') {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(`${EXPRESSIVE_MEDIA_LIBRARY_STORAGE_KEY}.`)) keys.add(key);
    }
  }
  const name = attachment.name.trim().toLocaleLowerCase();
  const mimeType = attachment.mimeType?.trim().toLocaleLowerCase() ?? '';
  for (const key of keys) {
    try {
      const values: unknown = JSON.parse(storage.getItem(key) ?? '[]');
      if (!Array.isArray(values)) continue;
      const match = values.find((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const item = value as Record<string, unknown>;
        return (item.kind === 'sticker' || item.kind === 'gif')
          && typeof item.name === 'string' && item.name.trim().toLocaleLowerCase() === name
          && typeof item.mimeType === 'string' && item.mimeType.trim().toLocaleLowerCase() === mimeType
          && item.sizeBytes === attachment.sizeBytes;
      }) as { kind?: unknown } | undefined;
      if (match?.kind === 'sticker' || match?.kind === 'gif') return match.kind;
    } catch {
      // Ignore one damaged library key and keep checking the remaining accounts.
    }
  }
  return null;
}

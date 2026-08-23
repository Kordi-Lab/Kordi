import {
  cacheDesktopCloudAttachment,
  cacheDesktopCloudAttachmentPath,
  cachedDesktopCloudAttachmentPath,
} from '@/lib/desktopCloudAttachmentCache';
import { isNativeDesktopShell } from '@/lib/desktop';

const paths = new Map<string, string>();

export function cloudAttachmentPreviewCacheId(attachmentId: string, previewAttachmentId?: string | null) {
  return `preview:${previewAttachmentId?.trim() || attachmentId.trim()}`;
}

export function cachedCloudAttachmentLocalPath(attachmentId: string) {
  return paths.get(attachmentId) ?? null;
}

export function cacheCloudAttachmentLocalPath(attachmentId: string, path: string) {
  paths.set(attachmentId, path);
}

export function clearCloudAttachmentLocalPathCache() {
  paths.clear();
}

export async function loadCachedCloudAttachmentLocalPath(
  attachmentId: string,
  name: string,
  load = cachedDesktopCloudAttachmentPath,
) {
  const cached = cachedCloudAttachmentLocalPath(attachmentId);
  if (cached) return cached;
  try {
    const path = await load(attachmentId, name);
    if (path) cacheCloudAttachmentLocalPath(attachmentId, path);
    return path;
  } catch {
    return null;
  }
}

export async function persistCloudAttachmentBytes(
  attachmentId: string,
  name: string,
  blob: Blob,
  store = cacheDesktopCloudAttachment,
) {
  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const path = await store(attachmentId, name, bytes);
    cacheCloudAttachmentLocalPath(attachmentId, path);
    return path;
  } catch {
    return null;
  }
}

export async function persistCloudAttachmentBlob(
  attachmentId: string,
  name: string,
  blob: Blob,
  fallback: (name: string, data: number[]) => Promise<string>,
) {
  const cached = isNativeDesktopShell()
    ? await persistCloudAttachmentBytes(attachmentId, name, blob)
    : null;
  return cached ?? fallback(
    name,
    Array.from(new Uint8Array(await blob.arrayBuffer())),
  );
}

export async function persistCloudAttachmentPath(
  attachmentId: string,
  name: string,
  path: string,
  store = cacheDesktopCloudAttachmentPath,
) {
  try {
    const cachedPath = await store(attachmentId, name, path);
    cacheCloudAttachmentLocalPath(attachmentId, cachedPath);
    return cachedPath;
  } catch {
    return null;
  }
}

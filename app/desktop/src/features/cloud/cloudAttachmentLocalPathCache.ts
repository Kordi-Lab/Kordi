import {
  cacheDesktopCloudAttachment,
  cacheDesktopCloudAttachmentPath,
  cachedDesktopCloudAttachmentPath,
  downloadDesktopCloudAttachment,
} from '@/lib/desktopCloudAttachmentCache';
import { isNativeDesktopShell } from '@/lib/desktop';

const MAX_MEMORY_PATHS = 256;
const paths = new Map<string, string>();

export function cloudAttachmentPreviewCacheId(attachmentId: string, previewAttachmentId?: string | null) {
  return `preview:${previewAttachmentId?.trim() || attachmentId.trim()}`;
}

export function cachedCloudAttachmentLocalPath(attachmentId: string) {
  const path = paths.get(attachmentId) ?? null;
  if (path) {
    paths.delete(attachmentId);
    paths.set(attachmentId, path);
  }
  return path;
}

export function cacheCloudAttachmentLocalPath(attachmentId: string, path: string) {
  paths.delete(attachmentId);
  paths.set(attachmentId, path);
  while (paths.size > MAX_MEMORY_PATHS) {
    const oldest = paths.keys().next().value;
    if (typeof oldest !== 'string') break;
    paths.delete(oldest);
  }
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
  if (!isNativeDesktopShell() && load === cachedDesktopCloudAttachmentPath) return null;
  try {
    const path = await load(attachmentId, name);
    if (path) cacheCloudAttachmentLocalPath(attachmentId, path);
    return path;
  } catch {
    return null;
  }
}

export async function downloadCloudAttachmentToLocalPath(
  token: string,
  attachmentId: string,
  name: string,
  download = downloadDesktopCloudAttachment,
) {
  const cached = await loadCachedCloudAttachmentLocalPath(attachmentId, name);
  if (cached) return cached;
  const path = await download(token, attachmentId, name);
  cacheCloudAttachmentLocalPath(attachmentId, path);
  return path;
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

export async function persistCloudAttachmentPreviewDataUrl(
  attachmentId: string,
  name: string,
  previewUrl: string,
) {
  try {
    const response = await fetch(previewUrl);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await persistCloudAttachmentBytes(
      cloudAttachmentPreviewCacheId(attachmentId),
      `${name}.preview.jpg`,
      blob,
    );
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

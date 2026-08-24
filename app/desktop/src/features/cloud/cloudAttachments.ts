import type { AttachmentItem } from '@/features/chat/composerController.types';
import type { MessageAttachment } from '@/kordi-app/types';
import { isNativeDesktopShell, storeDesktopChatAttachment } from '@/lib/desktop';
import type {
  CloudAuthClient,
  CloudMessageAttachment,
} from './authClient';
import { createCompressedImagePreviewDataUrl } from './cloudAttachmentPreviewGeneration';
import type { CloudAttachmentPreviewGenerator } from './cloudAttachmentPreviewRecovery';
import {
  cacheCloudAttachmentLocalPath,
  cachedCloudAttachmentLocalPath as cachedLocalPath,
  clearCloudAttachmentLocalPathCache,
  cloudAttachmentPreviewCacheId,
  downloadCloudAttachmentToLocalPath,
  loadCachedCloudAttachmentLocalPath,
  persistCloudAttachmentBlob,
  persistCloudAttachmentBytes,
} from './cloudAttachmentLocalPathCache';
import { safeCloudAttachmentPreviewUrl } from './cloudAttachmentPreviewUrl';

export { createCompressedImagePreviewDataUrl } from './cloudAttachmentPreviewGeneration';
export { recoverCloudAttachmentPreview } from './cloudAttachmentPreviewRecovery';
export { CLOUD_ATTACHMENT_PREVIEW_MAX_DATA_URL_LENGTH, safeCloudAttachmentPreviewUrl } from './cloudAttachmentPreviewUrl';
export { uploadComposerAttachments } from './cloudComposerAttachments';

export const CLOUD_ATTACHMENT_AUTO_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
// Transcript virtualization mounts a viewport plus 12 rows of overscan on each side.
// This bounds reusable idle cache entries. Active card and lightbox leases can keep
// evicted Blob URLs alive beyond this count until those consumers release them.
export const CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY = 128;

type CloudAttachmentPreviewResource = {
  previewUrl: string;
  leaseCount: number;
  cached: boolean;
  revoked: boolean;
};

export type CloudAttachmentPreviewLease = {
  previewUrl: string;
  retain(): CloudAttachmentPreviewLease;
  release(): void;
};

type PreviewDownloadClient = Pick<CloudAuthClient, 'downloadAttachmentContent'> & Partial<Pick<CloudAuthClient, 'downloadAttachmentPreviewContent'>>;
const cloudAttachmentPreviewUrlCache = new Map<string, CloudAttachmentPreviewResource>();
let cloudAttachmentPreviewLoaderEpoch = 0;

function revokeCloudAttachmentPreviewUrl(previewUrl: string) {
  if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
}

function revokeCloudAttachmentPreviewResource(resource: CloudAttachmentPreviewResource) {
  if (resource.revoked) return;
  resource.revoked = true;
  revokeCloudAttachmentPreviewUrl(resource.previewUrl);
}

function revokeUnownedCloudAttachmentPreviewResource(resource: CloudAttachmentPreviewResource) {
  if (!resource.cached && resource.leaseCount === 0) revokeCloudAttachmentPreviewResource(resource);
}

function cachedCloudAttachmentPreviewResource(cacheId: string) {
  const resource = cloudAttachmentPreviewUrlCache.get(cacheId);
  if (!resource || resource.revoked) return null;
  cloudAttachmentPreviewUrlCache.delete(cacheId);
  cloudAttachmentPreviewUrlCache.set(cacheId, resource);
  return resource;
}

function retainCloudAttachmentPreviewResource(cacheId: string, previewUrl: string) {
  const retainedResource = cachedCloudAttachmentPreviewResource(cacheId);
  if (retainedResource) {
    if (retainedResource.previewUrl !== previewUrl) revokeCloudAttachmentPreviewUrl(previewUrl);
    return retainedResource;
  }
  const resource: CloudAttachmentPreviewResource = {
    previewUrl,
    leaseCount: 0,
    cached: true,
    revoked: false,
  };
  cloudAttachmentPreviewUrlCache.set(cacheId, resource);
  if (cloudAttachmentPreviewUrlCache.size <= CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY) {
    return resource;
  }
  const oldestCacheId = cloudAttachmentPreviewUrlCache.keys().next().value;
  if (oldestCacheId !== undefined) {
    const oldestResource = cloudAttachmentPreviewUrlCache.get(oldestCacheId);
    cloudAttachmentPreviewUrlCache.delete(oldestCacheId);
    if (oldestResource) {
      oldestResource.cached = false;
      revokeUnownedCloudAttachmentPreviewResource(oldestResource);
    }
  }
  return resource;
}

function acquireCloudAttachmentPreviewLease(resource: CloudAttachmentPreviewResource): CloudAttachmentPreviewLease {
  if (resource.revoked) throw abortError();
  resource.leaseCount += 1;
  let released = false;
  return {
    previewUrl: resource.previewUrl,
    retain() {
      if (released) throw new Error('Cannot retain a released attachment preview lease.');
      return acquireCloudAttachmentPreviewLease(resource);
    },
    release() {
      if (released) return;
      released = true;
      resource.leaseCount = Math.max(0, resource.leaseCount - 1);
      revokeUnownedCloudAttachmentPreviewResource(resource);
    },
  };
}

type PreviewQueueTask<T> = {
  operation: (signal: AbortSignal) => Promise<T>;
  controller: AbortController;
  started: boolean;
  settled: boolean;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  removeAbortListener: () => void;
};

function abortError() {
  const error = new Error('Attachment preview request was aborted.');
  error.name = 'AbortError';
  return error;
}

async function publishCloudAttachmentPreviewLease(
  resource: CloudAttachmentPreviewResource,
  loaderEpoch: number,
  signal?: AbortSignal,
) {
  const lease = acquireCloudAttachmentPreviewLease(resource);
  await Promise.resolve();
  if (loaderEpoch !== cloudAttachmentPreviewLoaderEpoch || signal?.aborted || resource.revoked) {
    lease.release();
    throw abortError();
  }
  return lease;
}

export class CloudAttachmentPreviewQueue {
  private active = 0;
  private readonly tasks = new Set<PreviewQueueTask<unknown>>();
  private readonly queued: PreviewQueueTask<unknown>[] = [];

  constructor(private readonly concurrency = 4) {}

  run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const handleAbort = () => {
        controller.abort();
        if (!task.started) this.settle(task, () => reject(abortError()));
      };
      signal?.addEventListener('abort', handleAbort, { once: true });
      const task: PreviewQueueTask<unknown> = {
        operation: (taskSignal) => operation(taskSignal),
        controller,
        started: false,
        settled: false,
        resolve: (value) => resolve(value as T),
        reject,
        removeAbortListener: () => signal?.removeEventListener('abort', handleAbort),
      };
      this.tasks.add(task);
      this.queued.push(task);
      this.drain();
    });
  }

  clear() {
    for (const task of this.tasks) {
      task.controller.abort();
      this.settle(task, () => task.reject(abortError()));
    }
  }

  private drain() {
    while (this.active < Math.max(1, this.concurrency)) {
      const task = this.queued.shift();
      if (!task) return;
      if (task.settled) continue;
      if (task.controller.signal.aborted) {
        this.settle(task, () => task.reject(abortError()));
        continue;
      }
      task.started = true;
      this.active += 1;
      void task.operation(task.controller.signal)
        .then((value) => this.settle(task, () => task.resolve(value)))
        .catch((error) => this.settle(task, () => task.reject(error)))
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  private settle(task: PreviewQueueTask<unknown>, settle: () => void) {
    if (task.settled) return;
    task.settled = true;
    task.removeAbortListener();
    this.tasks.delete(task);
    settle();
  }
}

const visiblePreviewQueue = new CloudAttachmentPreviewQueue(4);

type PreviewGenerator = CloudAttachmentPreviewGenerator;

export function cachedCloudAttachmentLocalPath(attachmentId: string | null | undefined) {
  const id = attachmentId?.trim();
  return id ? cachedLocalPath(id) : null;
}

export function clearCloudAttachmentLocalPathCacheForTests() {
  clearCloudAttachmentLocalPathCache();
  resetCloudAttachmentPreviewLoader();
}

export function cloudMessageAttachmentToMessageAttachment(attachment: CloudMessageAttachment) {
  const localPath = attachment.localPath ?? cachedCloudAttachmentLocalPath(attachment.attachmentId);
  return {
    kind: attachment.kind,
    ...(attachment.subtype === 'meme' ? {
      subtype: 'meme' as const,
      altText: attachment.altText ?? null,
    } : {}),
    name: attachment.name,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    previewUrl: safeCloudAttachmentPreviewUrl(attachment.previewUrl),
    downloadUrl: null,
    localPath,
    attachmentId: attachment.attachmentId,
    ...(attachment.previewAttachmentId ? { previewAttachmentId: attachment.previewAttachmentId } : {}),
  };
}

export async function loadCloudAttachmentPreview({
  token,
  client,
  attachment,
  signal,
  createObjectUrl = (blob) => URL.createObjectURL(blob),
}: {
  token: string;
  client: PreviewDownloadClient;
  attachment: Pick<CloudMessageAttachment, 'attachmentId' | 'previewAttachmentId' | 'name' | 'kind'>;
  signal?: AbortSignal;
  createObjectUrl?: (blob: Blob) => string;
}) {
  if (attachment.kind !== 'image') return null;
  const contentAttachmentId = attachment.previewAttachmentId?.trim() || attachment.attachmentId?.trim();
  if (!contentAttachmentId) return null;
  const previewBlob = client.downloadAttachmentPreviewContent
    ? await client.downloadAttachmentPreviewContent(token, contentAttachmentId, signal).catch(() => null)
    : null;
  const blob = previewBlob
    ?? await client.downloadAttachmentContent(token, contentAttachmentId, signal);
  if (signal?.aborted) throw abortError();
  if (isNativeDesktopShell()) {
    await persistCloudAttachmentBytes(cloudAttachmentPreviewCacheId(attachment.attachmentId, attachment.previewAttachmentId), attachment.name, blob);
  }
  return createObjectUrl(blob);
}

export async function loadVisibleCloudAttachmentPreview(input: {
  token: string;
  client: PreviewDownloadClient;
  attachment: Pick<CloudMessageAttachment, 'attachmentId' | 'previewAttachmentId' | 'name' | 'kind'>;
  signal?: AbortSignal;
}) {
  const cacheId = input.attachment.previewAttachmentId?.trim() || input.attachment.attachmentId?.trim();
  if (!cacheId) return null;
  const loaderEpoch = cloudAttachmentPreviewLoaderEpoch;
  const cached = cachedCloudAttachmentPreviewResource(cacheId);
  if (cached) return publishCloudAttachmentPreviewLease(cached, loaderEpoch, input.signal);
  const resource = await visiblePreviewQueue.run(async (signal) => {
    const cachedInsideQueue = cachedCloudAttachmentPreviewResource(cacheId);
    if (cachedInsideQueue) return cachedInsideQueue;
    const previewUrl = await loadCloudAttachmentPreview({ ...input, signal });
    if (!previewUrl) return null;
    if (signal.aborted) {
      revokeCloudAttachmentPreviewUrl(previewUrl);
      throw abortError();
    }
    return retainCloudAttachmentPreviewResource(cacheId, previewUrl);
  }, input.signal);
  if (!resource) return null;
  return publishCloudAttachmentPreviewLease(resource, loaderEpoch, input.signal);
}

export function resetCloudAttachmentPreviewLoader() {
  cloudAttachmentPreviewLoaderEpoch += 1;
  visiblePreviewQueue.clear();
  for (const resource of cloudAttachmentPreviewUrlCache.values()) {
    resource.cached = false;
    revokeUnownedCloudAttachmentPreviewResource(resource);
  }
  cloudAttachmentPreviewUrlCache.clear();
}

export async function resolveCloudMessageAttachments({
  token,
  client,
  attachments,
  autoDownloadMaxBytes = CLOUD_ATTACHMENT_AUTO_DOWNLOAD_MAX_BYTES,
  downloadUnknownSizes = false,
  storeAttachment = storeDesktopChatAttachment,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'downloadAttachmentContent'>;
  attachments: CloudMessageAttachment[];
  autoDownloadMaxBytes?: number;
  downloadUnknownSizes?: boolean;
  storeAttachment?: (name: string, data: number[]) => Promise<string>;
}) {
  const resolved = [];
  for (const attachment of attachments) {
    const mapped = cloudMessageAttachmentToMessageAttachment(attachment);
    const cachedPath = cachedLocalPath(attachment.attachmentId)
      ?? await loadCachedCloudAttachmentLocalPath(attachment.attachmentId, attachment.name || 'attachment.bin');
    if (cachedPath) {
      resolved.push({ ...mapped, localPath: cachedPath });
      continue;
    }
    const shouldAutoDownload = typeof mapped.sizeBytes === 'number'
      ? mapped.sizeBytes >= 0 && mapped.sizeBytes <= autoDownloadMaxBytes
      : downloadUnknownSizes;
    if (!shouldAutoDownload) {
      resolved.push(mapped);
      continue;
    }
    try {
      if (isNativeDesktopShell()) {
        const localPath = await downloadCloudAttachmentToLocalPath(
          token,
          attachment.attachmentId,
          attachment.name || 'attachment.bin',
        );
        resolved.push({ ...mapped, localPath });
        continue;
      }
      const blob = await client.downloadAttachmentContent(token, attachment.attachmentId);
      if (blob.size > autoDownloadMaxBytes) {
        resolved.push(mapped);
        continue;
      }
      const localPath = await persistCloudAttachmentBlob(attachment.attachmentId, attachment.name || 'attachment.bin', blob, storeAttachment);
      cacheCloudAttachmentLocalPath(attachment.attachmentId, localPath);
      resolved.push({ ...mapped, localPath });
    } catch {
      resolved.push(mapped);
    }
  }
  return resolved;
}

export async function resolveForwardAttachmentItems({
  token,
  client,
  attachments,
  storeAttachment = storeDesktopChatAttachment,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'downloadAttachmentContent'>;
  attachments: MessageAttachment[];
  storeAttachment?: (name: string, data: number[]) => Promise<string>;
}): Promise<AttachmentItem[]> {
  const remoteAttachments = attachments.flatMap((attachment) => {
    if (attachment.localPath?.trim()) return [];
    const attachmentId = attachment.attachmentId?.trim();
    if (!attachmentId) return [];
    return [{
      attachmentId,
      previewAttachmentId: attachment.previewAttachmentId ?? null,
      name: attachment.name,
      kind: attachment.kind,
      ...(attachment.subtype === 'meme' ? {
        subtype: 'meme' as const,
        altText: attachment.altText ?? null,
      } : {}),
      mimeType: attachment.mimeType ?? null,
      sizeBytes: attachment.sizeBytes ?? null,
      downloadUrl: attachment.downloadUrl ?? null,
      previewUrl: attachment.previewUrl ?? null,
      localPath: null,
    } satisfies CloudMessageAttachment];
  });
  const resolvedRemoteAttachments = remoteAttachments.length > 0
    ? await resolveCloudMessageAttachments({
        token,
        client,
        attachments: remoteAttachments,
        autoDownloadMaxBytes: Number.MAX_SAFE_INTEGER,
        downloadUnknownSizes: true,
        storeAttachment,
      })
    : [];
  const resolvedPathByAttachmentId = new Map(
    resolvedRemoteAttachments.flatMap((attachment) => {
      const attachmentId = attachment.attachmentId?.trim();
      const localPath = attachment.localPath?.trim();
      return attachmentId && localPath ? [[attachmentId, localPath] as const] : [];
    }),
  );
  const unresolved: MessageAttachment[] = [];
  const resolved = attachments.flatMap((attachment, index) => {
    const attachmentId = attachment.attachmentId?.trim() || '';
    const path = attachment.localPath?.trim() || resolvedPathByAttachmentId.get(attachmentId) || '';
    if (!path) {
      unresolved.push(attachment);
      return [];
    }
    return [{
      ...attachment,
      ...(attachmentId ? { attachmentId } : {}),
      localPath: path,
      id: attachmentId || `forward-attachment:${index}:${attachment.name}`,
      path,
    } satisfies AttachmentItem];
  });
  if (unresolved.length > 0) {
    const subject = unresolved.length === 1
      ? `“${unresolved[0]!.name}”`
      : `${unresolved.length} attachments`;
    throw new Error(`Unable to forward ${subject} because the original file could not be downloaded.`);
  }
  return resolved;
}

export async function uploadCloudFiles({
  token,
  client,
  files,
  storeAttachment = storeDesktopChatAttachment,
  createPreviewDataUrl = createCompressedImagePreviewDataUrl,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'uploadAttachment'>;
  files: File[];
  storeAttachment?: (name: string, data: number[]) => Promise<string>;
  createPreviewDataUrl?: PreviewGenerator;
}): Promise<CloudMessageAttachment[]> {
  const uploaded: CloudMessageAttachment[] = [];
  for (const file of files) {
    const mimeType = file.type?.trim() || null;
    const kind = mimeType?.startsWith('image/') ? 'image' : 'file';
    const previewUrl = kind === 'image' ? await createPreviewDataUrl(file, { name: file.name || 'attachment', kind, mimeType, sizeBytes: file.size }) : null;
    const summary = await client.uploadAttachment(token, file);
    let localPath: string | null = null;
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      localPath = await storeAttachment(file.name || 'attachment.bin', bytes);
      cacheCloudAttachmentLocalPath(summary.attachmentId, localPath);
    } catch {
      localPath = null;
    }
    uploaded.push({
      attachmentId: summary.attachmentId,
      name: file.name || 'attachment',
      kind,
      mimeType,
      sizeBytes: file.size,
      downloadUrl: null,
      previewUrl: safeCloudAttachmentPreviewUrl(previewUrl),
      localPath,
    });
  }
  return uploaded;
}

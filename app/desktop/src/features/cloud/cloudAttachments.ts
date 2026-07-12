import type { AttachmentItem } from '@/features/chat/composerController.types';
import { readDesktopChatAttachment, storeDesktopChatAttachment } from '@/lib/desktop';
import type {
  CloudAuthClient,
  CloudMessageAttachment,
  SendCloudMessageAttachmentInput,
} from './authClient';

export const CLOUD_ATTACHMENT_AUTO_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
// Transcript virtualization mounts a viewport plus 12 rows of overscan on each side.
// Keep several mounted image windows warm while placing a hard ceiling on retained Blob URLs.
export const CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY = 128;

const cloudAttachmentLocalPathCache = new Map<string, string>();

type CloudAttachmentPreviewResource = {
  previewUrl: string;
  leaseCount: number;
  cached: boolean;
  revoked: boolean;
};

export type CloudAttachmentPreviewLease = {
  previewUrl: string;
  release(): void;
};

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

export function cachedCloudAttachmentLocalPath(attachmentId: string | null | undefined) {
  const id = attachmentId?.trim();
  return id ? cloudAttachmentLocalPathCache.get(id) ?? null : null;
}

export function clearCloudAttachmentLocalPathCacheForTests() {
  cloudAttachmentLocalPathCache.clear();
  resetCloudAttachmentPreviewLoader();
}

export function cloudMessageAttachmentToMessageAttachment(attachment: CloudMessageAttachment) {
  const localPath = attachment.localPath ?? cachedCloudAttachmentLocalPath(attachment.attachmentId);
  return {
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    previewUrl: null,
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
  client: Pick<CloudAuthClient, 'downloadAttachmentContent'>;
  attachment: Pick<CloudMessageAttachment, 'attachmentId' | 'previewAttachmentId' | 'kind'>;
  signal?: AbortSignal;
  createObjectUrl?: (blob: Blob) => string;
}) {
  if (attachment.kind !== 'image') return null;
  const contentAttachmentId = attachment.previewAttachmentId?.trim() || attachment.attachmentId?.trim();
  if (!contentAttachmentId) return null;
  const blob = await client.downloadAttachmentContent(token, contentAttachmentId, signal);
  if (signal?.aborted) throw abortError();
  return createObjectUrl(blob);
}

export async function loadVisibleCloudAttachmentPreview(input: {
  token: string;
  client: Pick<CloudAuthClient, 'downloadAttachmentContent'>;
  attachment: Pick<CloudMessageAttachment, 'attachmentId' | 'previewAttachmentId' | 'kind'>;
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
  storeAttachment = storeDesktopChatAttachment,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'downloadAttachmentContent'>;
  attachments: CloudMessageAttachment[];
  autoDownloadMaxBytes?: number;
  storeAttachment?: (name: string, data: number[]) => Promise<string>;
}) {
  const resolved = [];
  for (const attachment of attachments) {
    const mapped = cloudMessageAttachmentToMessageAttachment(attachment);
    const cachedPath = cloudAttachmentLocalPathCache.get(attachment.attachmentId);
    if (cachedPath) {
      resolved.push({ ...mapped, localPath: cachedPath });
      continue;
    }
    const shouldAutoDownload = typeof mapped.sizeBytes === 'number'
      && mapped.sizeBytes >= 0
      && mapped.sizeBytes <= autoDownloadMaxBytes;
    if (!shouldAutoDownload) {
      resolved.push(mapped);
      continue;
    }
    try {
      const blob = await client.downloadAttachmentContent(token, attachment.attachmentId);
      if (blob.size > autoDownloadMaxBytes) {
        resolved.push(mapped);
        continue;
      }
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const localPath = await storeAttachment(attachment.name || 'attachment.bin', bytes);
      cloudAttachmentLocalPathCache.set(attachment.attachmentId, localPath);
      resolved.push({ ...mapped, localPath });
    } catch {
      resolved.push(mapped);
    }
  }
  return resolved;
}

export async function uploadCloudFiles({
  token,
  client,
  files,
  storeAttachment = storeDesktopChatAttachment,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'uploadAttachment'>;
  files: File[];
  storeAttachment?: (name: string, data: number[]) => Promise<string>;
}): Promise<CloudMessageAttachment[]> {
  const uploaded: CloudMessageAttachment[] = [];
  for (const file of files) {
    const summary = await client.uploadAttachment(token, file);
    const mimeType = file.type?.trim() || null;
    const kind = mimeType?.startsWith('image/') ? 'image' : 'file';
    let localPath: string | null = null;
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      localPath = await storeAttachment(file.name || 'attachment.bin', bytes);
      cloudAttachmentLocalPathCache.set(summary.attachmentId, localPath);
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
      previewUrl: null,
      localPath,
    });
  }
  return uploaded;
}

export async function uploadComposerAttachments({
  token,
  client,
  attachments,
  readAttachment = readDesktopChatAttachment,
}: {
  token: string;
  client: Pick<CloudAuthClient, 'uploadAttachment'>;
  attachments: AttachmentItem[];
  readAttachment?: (path: string) => Promise<number[]>;
}): Promise<SendCloudMessageAttachmentInput[]> {
  const uploaded: SendCloudMessageAttachmentInput[] = [];
  for (const attachment of attachments) {
    const bytes = await readAttachment(attachment.path);
    const mimeType = attachment.mimeType?.trim() || null;
    const blob = new Blob([new Uint8Array(bytes)], mimeType ? { type: mimeType } : undefined);
    const summary = await client.uploadAttachment(token, blob);
    cloudAttachmentLocalPathCache.set(summary.attachmentId, attachment.path);
    uploaded.push({
      attachmentId: summary.attachmentId,
      name: attachment.name,
      kind: attachment.kind === 'image' ? 'image' : 'file',
      mimeType,
      sizeBytes: attachment.sizeBytes ?? blob.size,
    });
  }
  return uploaded;
}

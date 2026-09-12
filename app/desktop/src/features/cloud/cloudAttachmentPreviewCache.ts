export const CLOUD_ATTACHMENT_PREVIEW_IDLE_MS = 60_000;
export const CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY = 128;
export const CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES = 32 * 1024 * 1024;

export type CloudAttachmentPreviewResource = {
  previewUrl: string;
  memoryCostBytes: number;
  leaseCount: number;
  cached: boolean;
  revoked: boolean;
  lastUsedAt: number;
};

export type CloudAttachmentPreviewLease = {
  previewUrl: string;
  retain(): CloudAttachmentPreviewLease;
  release(): void;
};

const cache = new Map<string, CloudAttachmentPreviewResource>();
let cachedBytes = 0;
let epoch = 0;
const resetListeners = new Set<() => void>();
export function subscribeCloudAttachmentPreviewReset(listener: () => void) {
  resetListeners.add(listener);
  return () => { resetListeners.delete(listener); };
}
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

export function cloudAttachmentPreviewCacheEpoch() { return epoch; }

function evict(id: string, resource: CloudAttachmentPreviewResource) {
  cache.delete(id);
  cachedBytes -= resource.memoryCostBytes;
  resource.cached = false;
  revokeUnowned(resource);
}

function scheduleExpiry() {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  let next = Infinity;
  for (const resource of cache.values()) {
    if (resource.leaseCount === 0) next = Math.min(next, resource.lastUsedAt + CLOUD_ATTACHMENT_PREVIEW_IDLE_MS);
  }
  if (!Number.isFinite(next)) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    const now = Date.now();
    for (const [id, resource] of cache) {
      if (resource.leaseCount === 0 && now - resource.lastUsedAt >= CLOUD_ATTACHMENT_PREVIEW_IDLE_MS) evict(id, resource);
    }
    scheduleExpiry();
  }, Math.max(1, next - Date.now()));
  (expiryTimer as unknown as { unref?: () => void }).unref?.();
}

export function revokeCloudAttachmentPreviewUrl(url: string) {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

function revokeUnowned(resource: CloudAttachmentPreviewResource) {
  if (resource.cached || resource.leaseCount > 0 || resource.revoked) return;
  resource.revoked = true;
  revokeCloudAttachmentPreviewUrl(resource.previewUrl);
}

export function cachedCloudAttachmentPreviewResource(id: string) {
  const resource = cache.get(id);
  if (!resource || resource.revoked) return null;
  if (resource.leaseCount === 0 && Date.now() - resource.lastUsedAt >= CLOUD_ATTACHMENT_PREVIEW_IDLE_MS) {
    evict(id, resource); scheduleExpiry(); return null;
  }
  resource.lastUsedAt = Date.now();
  cache.delete(id);
  cache.set(id, resource);
  scheduleExpiry();
  return resource;
}

export function retainCloudAttachmentPreviewResource(id: string, previewUrl: string, memoryCostBytes: number) {
  const retained = cachedCloudAttachmentPreviewResource(id);
  if (retained) {
    if (retained.previewUrl !== previewUrl) revokeCloudAttachmentPreviewUrl(previewUrl);
    return retained;
  }
  const resource: CloudAttachmentPreviewResource = {
    previewUrl,
    memoryCostBytes: Math.max(0, Number.isFinite(memoryCostBytes) ? memoryCostBytes : CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES),
    leaseCount: 0, cached: true, revoked: false, lastUsedAt: Date.now(),
  };
  cache.set(id, resource);
  cachedBytes += resource.memoryCostBytes;
  scheduleExpiry();
  return resource;
}

function trimCache() {
  while (cache.size > CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY || cachedBytes > CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES) {
    const oldest = cache.entries().next().value;
    if (!oldest) break;
    const [id, resource] = oldest;
    evict(id, resource);
  }
}

export function acquireCloudAttachmentPreviewLease(resource: CloudAttachmentPreviewResource): CloudAttachmentPreviewLease {
  if (resource.revoked) throw new DOMException('Attachment preview was released.', 'AbortError');
  resource.leaseCount += 1;
  // Acquire first: an oversized resource can be used by its visible card even
  // when it cannot fit in the reusable cache. Last release then revokes it.
  trimCache();
  scheduleExpiry();
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
      resource.leaseCount -= 1;
      resource.lastUsedAt = Date.now();
      revokeUnowned(resource);
      scheduleExpiry();
    },
  };
}

export function clearCloudAttachmentPreviewCache() {
  epoch += 1;
  for (const listener of resetListeners) listener();
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  for (const resource of cache.values()) {
    resource.cached = false;
    revokeUnowned(resource);
  }
  cache.clear();
  cachedBytes = 0;
}

export function cloudAttachmentPreviewCacheUsage() {
  return { entries: cache.size, estimatedBytes: cachedBytes };
}

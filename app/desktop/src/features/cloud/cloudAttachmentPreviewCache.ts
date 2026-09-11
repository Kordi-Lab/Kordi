export const CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY = 128;
export const CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES = 32 * 1024 * 1024;

export type CloudAttachmentPreviewResource = {
  previewUrl: string;
  memoryCostBytes: number;
  leaseCount: number;
  cached: boolean;
  revoked: boolean;
};

export type CloudAttachmentPreviewLease = {
  previewUrl: string;
  retain(): CloudAttachmentPreviewLease;
  release(): void;
};

const cache = new Map<string, CloudAttachmentPreviewResource>();
let cachedBytes = 0;

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
  cache.delete(id);
  cache.set(id, resource);
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
    leaseCount: 0, cached: true, revoked: false,
  };
  cache.set(id, resource);
  cachedBytes += resource.memoryCostBytes;
  return resource;
}

function trimCache() {
  while (cache.size > CLOUD_ATTACHMENT_PREVIEW_CACHE_CAPACITY || cachedBytes > CLOUD_ATTACHMENT_PREVIEW_CACHE_BYTES) {
    const oldest = cache.entries().next().value;
    if (!oldest) break;
    const [id, resource] = oldest;
    cache.delete(id);
    cachedBytes -= resource.memoryCostBytes;
    resource.cached = false;
    revokeUnowned(resource);
  }
}

export function acquireCloudAttachmentPreviewLease(resource: CloudAttachmentPreviewResource): CloudAttachmentPreviewLease {
  if (resource.revoked) throw new DOMException('Attachment preview was released.', 'AbortError');
  resource.leaseCount += 1;
  // Acquire first: an oversized resource can be used by its visible card even
  // when it cannot fit in the reusable cache. Last release then revokes it.
  trimCache();
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
      revokeUnowned(resource);
    },
  };
}

export function clearCloudAttachmentPreviewCache() {
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

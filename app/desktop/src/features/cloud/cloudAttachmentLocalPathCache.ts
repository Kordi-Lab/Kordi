const paths = new Map<string, string>();

export function cachedCloudAttachmentLocalPath(attachmentId: string) {
  return paths.get(attachmentId) ?? null;
}

export function cacheCloudAttachmentLocalPath(attachmentId: string, path: string) {
  paths.set(attachmentId, path);
}

export function clearCloudAttachmentLocalPathCache() {
  paths.clear();
}

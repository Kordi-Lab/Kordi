/** The main image remains the original photo; these are its paired motion resources. */
export type LivePhotoResource = {
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};
export type LivePhoto = { video: LivePhotoResource; playback: LivePhotoResource };
export type LivePhotoFiles = { videoPath: string; playbackPath: string; previewPath?: string };

export function normalizedLivePhoto(value: unknown): LivePhoto | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  function resource(value: unknown, mimeTypes: string[]): LivePhotoResource | null {
    if (!value || typeof value !== 'object') return null;
    const r = value as Record<string, unknown>;
    if (typeof r.attachmentId !== 'string' || !r.attachmentId.trim()
      || typeof r.name !== 'string' || !r.name.trim()
      || typeof r.mimeType !== 'string' || !mimeTypes.includes(r.mimeType)
      || typeof r.sizeBytes !== 'number' || !Number.isSafeInteger(r.sizeBytes)
      || r.sizeBytes <= 0 || r.sizeBytes > 256 * 1024 * 1024) return null;
    return { attachmentId: r.attachmentId, name: r.name, mimeType: r.mimeType, sizeBytes: r.sizeBytes };
  }
  const video = resource(record.video, ['video/quicktime']);
  const playback = resource(record.playback, ['video/mp4']);
  return video && playback && video.attachmentId !== playback.attachmentId ? { video, playback } : undefined;
}

export function normalizedLivePhotoFiles(value: unknown): LivePhotoFiles | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  return typeof r.videoPath === 'string' && r.videoPath.trim()
    && typeof r.playbackPath === 'string' && r.playbackPath.trim()
    ? { videoPath: r.videoPath, playbackPath: r.playbackPath,
        ...(typeof r.previewPath === 'string' && r.previewPath.trim() ? { previewPath: r.previewPath } : {}) } : undefined;
}

export function livePhotoAttachmentIds(attachment: { attachmentId: string; livePhoto?: LivePhoto | null }): string[] {
  return [attachment.attachmentId, ...(attachment.livePhoto
    ? [attachment.livePhoto.video.attachmentId, attachment.livePhoto.playback.attachmentId] : [])];
}

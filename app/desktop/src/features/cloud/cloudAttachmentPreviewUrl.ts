export const CLOUD_ATTACHMENT_PREVIEW_MAX_DATA_URL_LENGTH = 360_000;

function isInternalObjectStoreUrl(value?: string | null) {
  if (!value) return false;
  try {
    return new URL(value).hostname === 'minio.kordi-cloud.svc.cluster.local';
  } catch {
    return value.includes('minio.kordi-cloud.svc.cluster.local');
  }
}

export function safeCloudAttachmentPreviewUrl(value?: string | null) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed.length > CLOUD_ATTACHMENT_PREVIEW_MAX_DATA_URL_LENGTH) return null;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(trimmed)) return trimmed;
  if (isInternalObjectStoreUrl(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? trimmed : null;
  } catch {
    return null;
  }
}

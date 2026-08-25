import { cloudApiBaseUrl } from './cloudApiEnvironment';

export const CANONICAL_AVATAR_RENDERER_VERSION = 'dicebear-rust-10.6.0-styles-10.5.0';
export const HUMAN_CANONICAL_AVATAR_STYLE = 'lorelei';
export const AGENT_CANONICAL_AVATAR_STYLE = 'thumbs';
export const CANONICAL_AVATAR_URL_PREFIX = 'kordi-avatar://';
export const AVATAR_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const UPLOADED_AVATAR_HOST = 'uploaded';

export type CanonicalAvatarStyle = 'lorelei' | 'thumbs';
export type CanonicalAvatarSource = 'generated' | 'uploaded';

export type CanonicalAvatarDescriptor = {
  entityType: string;
  entityId: string;
  source: CanonicalAvatarSource;
  style: CanonicalAvatarStyle;
  seed: string;
  rendererVersion: string;
  uploadedAsset: string | null;
  version: number;
  updatedAt: string;
};

export type CanonicalAvatarMutation = {
  action: 'upload' | 'regenerate' | 'remove_upload';
  uploadedAsset?: string;
  seed?: string;
  expectedVersion?: number;
};

export type GeneratedAvatarMarker = {
  rendererVersion: string;
  style: CanonicalAvatarStyle;
  seed: string;
  version: number;
};

export type UploadedAvatarMarker = {
  assetId: string;
};

function supportedStyle(value: string): value is CanonicalAvatarStyle {
  return value === HUMAN_CANONICAL_AVATAR_STYLE || value === AGENT_CANONICAL_AVATAR_STYLE;
}

function validSeed(value: string) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function parseGeneratedAvatarMarker(value: string | null | undefined): GeneratedAvatarMarker | null {
  const trimmed = value?.trim();
  if (!trimmed?.startsWith(CANONICAL_AVATAR_URL_PREFIX)) return null;
  try {
    const url = new URL(trimmed);
    const style = url.pathname.split('/').filter(Boolean)[0] ?? '';
    const seed = url.pathname.split('/').filter(Boolean)[1] ?? '';
    const version = Number.parseInt(url.searchParams.get('version') ?? '', 10);
    if (
      url.hostname !== CANONICAL_AVATAR_RENDERER_VERSION
      || !supportedStyle(style)
      || !validSeed(seed)
      || !Number.isSafeInteger(version)
      || version < 1
    ) return null;
    return {
      rendererVersion: url.hostname,
      style,
      seed,
      version,
    };
  } catch {
    return null;
  }
}

export function generatedAvatarMarker(
  style: CanonicalAvatarStyle,
  seed: string,
  version: number,
) {
  if (!validSeed(seed)) throw new Error('Generated avatar seed is invalid.');
  return `${CANONICAL_AVATAR_URL_PREFIX}${CANONICAL_AVATAR_RENDERER_VERSION}/${style}/${seed}?version=${version}`;
}

export function generatedAvatarRenderUrl(value: string | null | undefined): string | null {
  const marker = parseGeneratedAvatarMarker(value);
  if (!marker) return null;
  try {
    const baseUrl = cloudApiBaseUrl();
    return `${baseUrl}/v1/avatars/${marker.rendererVersion}/${marker.style}/${encodeURIComponent(marker.seed)}.png?v=${marker.version}`;
  } catch {
    return null;
  }
}

export function parseUploadedAvatarMarker(
  value: string | null | undefined,
): UploadedAvatarMarker | null {
  const trimmed = value?.trim();
  if (!trimmed?.startsWith(CANONICAL_AVATAR_URL_PREFIX)) return null;
  try {
    const url = new URL(trimmed);
    const assetId = url.pathname.split('/').filter(Boolean)[0] ?? '';
    if (
      url.hostname !== UPLOADED_AVATAR_HOST
      || !/^ava_[0-9a-f]{32}$/i.test(assetId)
      || url.pathname.split('/').filter(Boolean).length !== 1
    ) return null;
    return { assetId };
  } catch {
    return null;
  }
}

export function uploadedAvatarRenderUrl(
  value: string | null | undefined,
  size: 64 | 128 | 256 | 512 = 256,
): string | null {
  const marker = parseUploadedAvatarMarker(value);
  if (!marker) return null;
  try {
    return `${cloudApiBaseUrl()}/v1/avatars/assets/${encodeURIComponent(marker.assetId)}/${size}.jpg`;
  } catch {
    return null;
  }
}

export function generatedAvatarPreviewUrl(
  style: CanonicalAvatarStyle,
  seed: string,
  baseUrl?: string,
): string | null {
  if (!supportedStyle(style) || !validSeed(seed)) return null;
  try {
    return `${baseUrl ?? cloudApiBaseUrl()}/v1/avatars/preview/${style}/${encodeURIComponent(seed)}.png`;
  } catch {
    return null;
  }
}

export function canonicalAvatarImageUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(CANONICAL_AVATAR_URL_PREFIX)) {
    return uploadedAvatarRenderUrl(trimmed) ?? generatedAvatarRenderUrl(trimmed);
  }
  return trimmed;
}

export function avatarDataUrlBlob(value: string): Blob {
  const [metadata, payload] = value.split(',', 2);
  const contentType = /^data:(image\/(?:png|jpeg|webp));base64$/i.exec(metadata)?.[1]?.toLowerCase();
  if (!contentType || !payload) throw new Error('Choose a PNG, JPEG, or WebP image.');
  const binary = atob(payload);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength > AVATAR_SOURCE_MAX_BYTES) throw new Error('Avatar source must be 2 MiB or smaller.');
  return new Blob([bytes], { type: contentType });
}

export function canonicalAvatarImageSource(descriptor: CanonicalAvatarDescriptor): string | null {
  return descriptor.source === 'uploaded'
    ? descriptor.uploadedAsset
    : generatedAvatarMarker(descriptor.style, descriptor.seed, descriptor.version);
}

export function normalizeCanonicalAvatarDescriptor(value: unknown): CanonicalAvatarDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const entityType = typeof record.entityType === 'string' ? record.entityType.trim() : '';
  const entityId = typeof record.entityId === 'string' ? record.entityId.trim() : '';
  const source = typeof record.source === 'string' ? record.source.trim() : '';
  const style = typeof record.style === 'string' ? record.style.trim() : '';
  const seed = typeof record.seed === 'string' ? record.seed.trim() : '';
  const rendererVersion = typeof record.rendererVersion === 'string' ? record.rendererVersion.trim() : '';
  const uploadedAsset = typeof record.uploadedAsset === 'string' ? record.uploadedAsset.trim() || null : null;
  const version = typeof record.version === 'number' ? record.version : Number.NaN;
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt.trim() : '';
  if (
    !entityType
    || !entityId
    || (source !== 'generated' && source !== 'uploaded')
    || !supportedStyle(style)
    || !validSeed(seed)
    || rendererVersion !== CANONICAL_AVATAR_RENDERER_VERSION
    || !Number.isSafeInteger(version)
    || version < 1
    || !updatedAt
    || (source === 'uploaded' && !uploadedAsset)
  ) return null;
  return {
    entityType,
    entityId,
    source,
    style,
    seed,
    rendererVersion,
    uploadedAsset,
    version,
    updatedAt,
  };
}

export function newCanonicalAvatarSeed() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}${random}`.slice(0, 128);
}

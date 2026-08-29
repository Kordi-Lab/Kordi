import { invokeDesktop } from '@/lib/desktop';
import { safeExternalHttpHref } from './messageLinks';

type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type LinkPreviewMetadata = {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
};

type CachedLinkPreview = {
  expiresAt: number;
  metadata: LinkPreviewMetadata;
};

const LINK_PREVIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const LINK_PREVIEW_FAILURE_TTL_MS = 60_000;
const MAX_LINK_PREVIEW_CACHE_ENTRIES = 64;
const cachedLinkPreviews = new Map<string, CachedLinkPreview>();
const failedLinkPreviews = new Map<string, number>();
const inFlightLinkPreviews = new Map<string, Promise<LinkPreviewMetadata>>();

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizedLinkPreviewMetadata(value: unknown): LinkPreviewMetadata {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const imageUrl = safeExternalHttpHref(boundedText(record.imageUrl, 4_096) ?? '');
  return {
    title: boundedText(record.title, 200),
    description: boundedText(record.description, 320),
    imageUrl: imageUrl && new URL(imageUrl).protocol.toLowerCase() === 'https:' ? imageUrl : null,
    siteName: boundedText(record.siteName, 80),
  };
}

export function readCachedLinkPreview(href: string, now = Date.now()): LinkPreviewMetadata | null {
  const cached = cachedLinkPreviews.get(href);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    cachedLinkPreviews.delete(href);
    return null;
  }
  cachedLinkPreviews.delete(href);
  cachedLinkPreviews.set(href, cached);
  return cached.metadata;
}

function rememberLinkPreview(href: string, metadata: LinkPreviewMetadata, now = Date.now()) {
  cachedLinkPreviews.delete(href);
  while (cachedLinkPreviews.size >= MAX_LINK_PREVIEW_CACHE_ENTRIES) {
    const oldest = cachedLinkPreviews.keys().next().value;
    if (typeof oldest !== 'string') break;
    cachedLinkPreviews.delete(oldest);
  }
  cachedLinkPreviews.set(href, { metadata, expiresAt: now + LINK_PREVIEW_CACHE_TTL_MS });
}

export function loadLinkPreviewMetadata(
  href: string,
  invoke: NativeInvoke = invokeDesktop,
): Promise<LinkPreviewMetadata> {
  const safeHref = safeExternalHttpHref(href);
  if (!safeHref || new URL(safeHref).protocol.toLowerCase() !== 'https:') {
    return Promise.reject(new Error('Link previews require a public HTTPS URL.'));
  }
  const cached = readCachedLinkPreview(safeHref);
  if (cached) return Promise.resolve(cached);
  const inFlight = inFlightLinkPreviews.get(safeHref);
  if (inFlight) return inFlight;
  const failedAt = failedLinkPreviews.get(safeHref);
  if (failedAt && Date.now() - failedAt < LINK_PREVIEW_FAILURE_TTL_MS) {
    return Promise.reject(new Error('Link preview is temporarily unavailable.'));
  }
  failedLinkPreviews.delete(safeHref);

  const request = invoke<unknown>('desktop_fetch_link_preview_metadata', { url: safeHref })
    .then((value) => {
      const metadata = normalizedLinkPreviewMetadata(value);
      rememberLinkPreview(safeHref, metadata);
      failedLinkPreviews.delete(safeHref);
      inFlightLinkPreviews.delete(safeHref);
      return metadata;
    })
    .catch((error: unknown) => {
      failedLinkPreviews.set(safeHref, Date.now());
      inFlightLinkPreviews.delete(safeHref);
      throw error;
    });
  inFlightLinkPreviews.set(safeHref, request);
  return request;
}

export function clearLinkPreviewCacheForTests() {
  cachedLinkPreviews.clear();
  failedLinkPreviews.clear();
  inFlightLinkPreviews.clear();
}

export function getLinkPreviewCacheStatsForTests() {
  return {
    entries: cachedLinkPreviews.size,
    failed: failedLinkPreviews.size,
    inFlight: inFlightLinkPreviews.size,
    maxEntries: MAX_LINK_PREVIEW_CACHE_ENTRIES,
  };
}

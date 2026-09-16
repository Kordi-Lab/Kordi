const WIKIMEDIA_COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
const PUBLIC_GIF_DEFAULT_QUERY = 'funny';
const PUBLIC_GIF_SEARCH_LIMIT = 24;
const PUBLIC_GIF_RESULT_LIMIT = 18;
const PUBLIC_GIF_MAX_BYTES = 2 * 1024 * 1024;
const PUBLIC_GIF_CACHE_LIMIT = 24;

export type PublicGifResult = {
  id: string;
  title: string;
  mediaUrl: string;
  previewUrl: string;
  license: 'CC0' | 'Public domain';
};

const publicGifSearchCache = new Map<string, Promise<PublicGifResult[]>>();

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function trustedWikimediaUrl(value: unknown, hostname: string) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

function publicLicense(value: unknown): PublicGifResult['license'] | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase().replace(/\s+/g, '');
  if (normalized === 'cc0') return 'CC0';
  if (normalized === 'publicdomain') return 'Public domain';
  return null;
}

export function normalizePublicGifQuery(query: string) {
  return query.trim().slice(0, 100) || PUBLIC_GIF_DEFAULT_QUERY;
}

export function publicGifSearchUrl(query: string) {
  const url = new URL(WIKIMEDIA_COMMONS_API_URL);
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    generator: 'search',
    gsrsearch: `${normalizePublicGifQuery(query)} filemime:image/gif`,
    gsrnamespace: '6',
    gsrlimit: String(PUBLIC_GIF_SEARCH_LIMIT),
    gsrsort: 'relevance',
    prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata',
    iiurlwidth: '320',
  }).toString();
  return url.toString();
}

export function parsePublicGifSearchResponse(value: unknown): PublicGifResult[] {
  const root = recordValue(value);
  const query = recordValue(root?.query);
  const pages = Array.isArray(query?.pages) ? query.pages : [];
  return pages.flatMap((pageValue) => {
    const page = recordValue(pageValue);
    const imageInfoList = Array.isArray(page?.imageinfo) ? page.imageinfo : [];
    const imageInfo = recordValue(imageInfoList[0]);
    const metadata = recordValue(imageInfo?.extmetadata);
    const licenseMetadata = recordValue(metadata?.LicenseShortName);
    const license = publicLicense(licenseMetadata?.value);
    const pageId = typeof page?.pageid === 'number' && Number.isFinite(page.pageid)
      ? String(page.pageid)
      : '';
    const rawTitle = typeof page?.title === 'string' ? page.title : '';
    const title = rawTitle.replace(/^File:/i, '').replace(/\.gif$/i, '').trim();
    const mimeType = typeof imageInfo?.mime === 'string' ? imageInfo.mime : '';
    const sizeBytes = typeof imageInfo?.size === 'number' && Number.isFinite(imageInfo.size)
      ? imageInfo.size
      : 0;
    const mediaUrl = trustedWikimediaUrl(imageInfo?.url, 'upload.wikimedia.org');
    const previewUrl = trustedWikimediaUrl(imageInfo?.thumburl, 'upload.wikimedia.org') ?? mediaUrl;
    const index = typeof page?.index === 'number' && Number.isFinite(page.index)
      ? page.index
      : Number.MAX_SAFE_INTEGER;
    if (
      !pageId
      || !title
      || !license
      || !mediaUrl
      || !previewUrl
      || mimeType !== 'image/gif'
      || sizeBytes <= 0
      || sizeBytes > PUBLIC_GIF_MAX_BYTES
    ) return [];
    return [{ id: pageId, title, mediaUrl, previewUrl, license, index }];
  })
    .sort((left, right) => left.index - right.index)
    .slice(0, PUBLIC_GIF_RESULT_LIMIT)
    .map(({ index: _index, ...result }) => result);
}

async function requestPublicGifs(query: string) {
  const response = await fetch(publicGifSearchUrl(query));
  if (response.status === 429) {
    throw new Error('Public GIF search is busy. Try again in a moment.');
  }
  if (!response.ok) throw new Error('The public GIF catalog is unavailable right now.');
  return parsePublicGifSearchResponse(await response.json());
}

export function clearPublicGifSearch(query: string) {
  publicGifSearchCache.delete(normalizePublicGifQuery(query).toLocaleLowerCase());
}

export function loadPublicGifs(query: string) {
  const normalizedQuery = normalizePublicGifQuery(query);
  const cacheKey = normalizedQuery.toLocaleLowerCase();
  const cached = publicGifSearchCache.get(cacheKey);
  if (cached) return cached;
  if (publicGifSearchCache.size >= PUBLIC_GIF_CACHE_LIMIT) {
    const oldestKey = publicGifSearchCache.keys().next().value;
    if (typeof oldestKey === 'string') publicGifSearchCache.delete(oldestKey);
  }
  const request = requestPublicGifs(normalizedQuery).catch((error: unknown) => {
    publicGifSearchCache.delete(cacheKey);
    throw error;
  });
  publicGifSearchCache.set(cacheKey, request);
  return request;
}

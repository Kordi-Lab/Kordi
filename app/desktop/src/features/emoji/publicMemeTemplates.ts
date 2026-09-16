const WIKIMEDIA_COMMONS_API_URL = 'https://commons.wikimedia.org/w/api.php';
const PUBLIC_STICKER_DEFAULT_QUERY = 'reaction';
const PUBLIC_STICKER_SEARCH_LIMIT = 36;
const PUBLIC_STICKER_RESULT_LIMIT = 24;
const PUBLIC_STICKER_MAX_BYTES = 2 * 1024 * 1024;
const PUBLIC_STICKER_CACHE_LIMIT = 24;

export type PublicMemeTemplate = {
  id: string;
  name: string;
  imageUrl: string;
  previewUrl: string;
  license: 'CC0' | 'Public domain';
  keywords: string[];
};

const publicStickerSearchCache = new Map<string, Promise<PublicMemeTemplate[]>>();

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function trustedWikimediaUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'upload.wikimedia.org'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function publicLicense(value: unknown): PublicMemeTemplate['license'] | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase().replace(/\s+/g, '');
  if (normalized === 'cc0') return 'CC0';
  if (normalized === 'publicdomain') return 'Public domain';
  return null;
}

export function normalizePublicStickerQuery(query: string) {
  return query.trim().slice(0, 100) || PUBLIC_STICKER_DEFAULT_QUERY;
}

export function publicStickerSearchUrl(query: string) {
  const url = new URL(WIKIMEDIA_COMMONS_API_URL);
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    generator: 'search',
    gsrsearch: `${normalizePublicStickerQuery(query)} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: String(PUBLIC_STICKER_SEARCH_LIMIT),
    gsrsort: 'relevance',
    prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata',
    iiurlwidth: '320',
  }).toString();
  return url.toString();
}

export function parsePublicMemeTemplates(value: unknown): PublicMemeTemplate[] {
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
    const id = typeof page?.pageid === 'number' && Number.isFinite(page.pageid) ? String(page.pageid) : '';
    const rawName = typeof page?.title === 'string' ? page.title : '';
    const name = rawName.replace(/^File:/i, '').replace(/\.(?:png|jpe?g|webp)$/i, '').trim();
    const mimeType = typeof imageInfo?.mime === 'string' ? imageInfo.mime.toLocaleLowerCase() : '';
    const sizeBytes = typeof imageInfo?.size === 'number' && Number.isFinite(imageInfo.size) ? imageInfo.size : 0;
    const imageUrl = trustedWikimediaUrl(imageInfo?.url);
    const previewUrl = trustedWikimediaUrl(imageInfo?.thumburl) ?? imageUrl;
    const index = typeof page?.index === 'number' && Number.isFinite(page.index) ? page.index : Number.MAX_SAFE_INTEGER;
    if (
      !id || !name || !license || !imageUrl || !previewUrl
      || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
      || sizeBytes <= 0 || sizeBytes > PUBLIC_STICKER_MAX_BYTES
    ) return [];
    return [{ id, name, imageUrl, previewUrl, license, keywords: [], index }];
  })
    .sort((left, right) => left.index - right.index)
    .slice(0, PUBLIC_STICKER_RESULT_LIMIT)
    .map(({ index: _index, ...result }) => result);
}

export function filterPublicMemeTemplates(
  templates: PublicMemeTemplate[],
  query: string,
  limit = PUBLIC_STICKER_RESULT_LIMIT,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter((template) => {
    if (terms.length === 0) return true;
    return terms.every((term) => template.name.toLocaleLowerCase().includes(term));
  }).slice(0, limit);
}

async function requestPublicStickers(query: string) {
  const response = await fetch(publicStickerSearchUrl(query));
  if (response.status === 429) throw new Error('Public sticker search is busy. Try again in a moment.');
  if (!response.ok) throw new Error('The public sticker catalog is unavailable right now.');
  return parsePublicMemeTemplates(await response.json());
}

export function clearPublicStickerSearch(query: string) {
  publicStickerSearchCache.delete(normalizePublicStickerQuery(query).toLocaleLowerCase());
}

export function loadPublicMemeTemplates(query: string) {
  const normalizedQuery = normalizePublicStickerQuery(query);
  const cacheKey = normalizedQuery.toLocaleLowerCase();
  const cached = publicStickerSearchCache.get(cacheKey);
  if (cached) return cached;
  if (publicStickerSearchCache.size >= PUBLIC_STICKER_CACHE_LIMIT) {
    const oldestKey = publicStickerSearchCache.keys().next().value;
    if (typeof oldestKey === 'string') publicStickerSearchCache.delete(oldestKey);
  }
  const request = requestPublicStickers(normalizedQuery).catch((error: unknown) => {
    publicStickerSearchCache.delete(cacheKey);
    throw error;
  });
  publicStickerSearchCache.set(cacheKey, request);
  return request;
}

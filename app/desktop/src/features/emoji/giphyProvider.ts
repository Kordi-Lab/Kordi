export type GiphyMediaKind = 'gif' | 'sticker';

export type GiphyProviderMedia = {
  provider: 'giphy';
  providerMediaId: string;
  mediaKind: GiphyMediaKind;
  title: string;
  altText: string;
  width: number;
  height: number;
  rating: string;
  shareUrl: string;
  previewUrl: string;
  playbackUrl: string;
};

type GiphyImage = {
  url?: string;
  mp4?: string;
  width?: string;
  height?: string;
};

type GiphyRecord = {
  id?: string;
  title?: string;
  alt_text?: string;
  rating?: string;
  url?: string;
  type?: string;
  images?: Record<string, GiphyImage | undefined>;
};

const selectedMediaByShareUrl = new Map<string, GiphyProviderMedia>();

export function giphyAPIKey(): string {
  return (import.meta.env.VITE_GIPHY_API_KEY ?? '').trim();
}

export function giphyConfigured(): boolean {
  return Boolean(giphyAPIKey());
}

function number(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function mapRecord(record: GiphyRecord, fallbackKind: GiphyMediaKind): GiphyProviderMedia | null {
  const id = record.id?.trim() ?? '';
  if (!id) return null;
  const preview = record.images?.fixed_width_small_still
    ?? record.images?.fixed_width_small
    ?? record.images?.fixed_width
    ?? record.images?.original;
  const playback = record.images?.fixed_width
    ?? record.images?.downsized
    ?? record.images?.original;
  const previewUrl = preview?.url?.trim() ?? '';
  const playbackUrl = playback?.mp4?.trim() || playback?.url?.trim() || '';
  if (!previewUrl || !playbackUrl) return null;
  const kind = record.type === 'sticker' ? 'sticker' : fallbackKind;
  const title = record.title?.trim() || (kind === 'gif' ? 'GIF' : 'Sticker');
  return {
    provider: 'giphy',
    providerMediaId: id,
    mediaKind: kind,
    title,
    altText: record.alt_text?.trim() || title,
    width: number(playback?.width),
    height: number(playback?.height),
    rating: record.rating?.trim().toLowerCase() || 'g',
    shareUrl: record.url?.trim() || `https://giphy.com/gifs/${id}`,
    previewUrl,
    playbackUrl,
  };
}

async function request(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const apiKey = giphyAPIKey();
  if (!apiKey) throw new Error('GIPHY is not configured for this build.');
  const url = new URL(`https://api.giphy.com/v1/${path}`);
  url.search = new URLSearchParams({ api_key: apiKey, rating: 'g', ...params }).toString();
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`GIPHY request failed (${response.status}).`);
  return response.json();
}

export async function searchGiphyMedia(
  query: string,
  kind: GiphyMediaKind,
  signal?: AbortSignal,
): Promise<GiphyProviderMedia[]> {
  if (signal?.aborted) return [];
  const normalizedQuery = query.trim();
  const endpoint = normalizedQuery ? `${kind}s/search` : `${kind}s/trending`;
  const payload = await request(endpoint, {
    ...(normalizedQuery ? { q: normalizedQuery } : {}),
    limit: '30',
  }, signal) as { data?: GiphyRecord[] };
  if (signal?.aborted) return [];
  return (payload.data ?? []).map((record) => mapRecord(record, kind)).filter((item): item is GiphyProviderMedia => Boolean(item));
}

export async function lookupGiphyMedia(
  id: string,
  kind: GiphyMediaKind,
): Promise<GiphyProviderMedia | null> {
  const payload = await request(`gifs/${encodeURIComponent(id)}`, {}) as { data?: GiphyRecord };
  return payload.data ? mapRecord(payload.data, kind) : null;
}

export function rememberGiphySelection(media: GiphyProviderMedia): string {
  selectedMediaByShareUrl.set(media.shareUrl, media);
  return media.shareUrl;
}

export function giphySelectionForText(text: string): GiphyProviderMedia | null {
  const normalized = text.trim();
  const selected = selectedMediaByShareUrl.get(normalized);
  if (selected) return selected;
  const urlMatch = /^https:\/\/(?:www\.)?giphy\.com\/(?:gifs|stickers)\/(?:[^/]*-)?([a-zA-Z0-9]+)\/?$/.exec(normalized);
  if (!urlMatch) return null;
  return {
    provider: 'giphy',
    providerMediaId: urlMatch[1],
    mediaKind: normalized.includes('/stickers/') ? 'sticker' : 'gif',
    title: normalized.includes('/stickers/') ? 'GIPHY sticker' : 'GIPHY GIF',
    altText: normalized.includes('/stickers/') ? 'Shared GIPHY sticker' : 'Shared GIPHY GIF',
    width: 1,
    height: 1,
    rating: 'g',
    shareUrl: normalized,
    previewUrl: '',
    playbackUrl: '',
  };
}

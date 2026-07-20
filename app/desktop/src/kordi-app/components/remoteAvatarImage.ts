type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const MAX_CACHED_REMOTE_AVATARS = 64;
const MAX_CACHED_REMOTE_AVATAR_BYTES = 16 * 1024 * 1024;
type RemoteAvatarCacheEntry = { dataUrl: string; estimatedBytes: number };
const resolvedRemoteAvatars = new Map<string, RemoteAvatarCacheEntry>();
const inFlightRemoteAvatars = new Map<string, Promise<string>>();
let resolvedRemoteAvatarBytes = 0;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

export function shouldLoadAvatarThroughNativeProxy(
  imageUrl: string | null | undefined,
  tauriRuntime = isTauriRuntime(),
): boolean {
  if (!tauriRuntime) return false;
  const normalized = imageUrl?.trim() ?? '';
  return normalized.startsWith('https://');
}

async function defaultNativeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

function estimatedStringBytes(value: string): number {
  // Data URLs are ASCII today, but counting two bytes per character keeps the
  // budget conservative across JavaScript engines and future payload formats.
  return value.length * 2;
}

function readResolvedRemoteAvatar(url: string): string | null {
  const cached = resolvedRemoteAvatars.get(url);
  if (!cached) return null;
  resolvedRemoteAvatars.delete(url);
  resolvedRemoteAvatars.set(url, cached);
  return cached.dataUrl;
}

function evictOldestResolvedRemoteAvatar(): boolean {
  const oldest = resolvedRemoteAvatars.entries().next().value as [string, RemoteAvatarCacheEntry] | undefined;
  if (!oldest) return false;
  const [url, entry] = oldest;
  resolvedRemoteAvatars.delete(url);
  resolvedRemoteAvatarBytes -= entry.estimatedBytes;
  return true;
}

function rememberResolvedRemoteAvatar(url: string, dataUrl: string): void {
  const estimatedBytes = estimatedStringBytes(dataUrl);
  if (estimatedBytes > MAX_CACHED_REMOTE_AVATAR_BYTES) return;

  const existing = resolvedRemoteAvatars.get(url);
  if (existing) {
    resolvedRemoteAvatars.delete(url);
    resolvedRemoteAvatarBytes -= existing.estimatedBytes;
  }

  while (
    resolvedRemoteAvatars.size >= MAX_CACHED_REMOTE_AVATARS
    || resolvedRemoteAvatarBytes + estimatedBytes > MAX_CACHED_REMOTE_AVATAR_BYTES
  ) {
    if (!evictOldestResolvedRemoteAvatar()) break;
  }

  resolvedRemoteAvatars.set(url, { dataUrl, estimatedBytes });
  resolvedRemoteAvatarBytes += estimatedBytes;
}

export function loadAvatarThroughNativeProxy(
  imageUrl: string,
  invoke: NativeInvoke = defaultNativeInvoke,
): Promise<string> {
  const normalized = imageUrl.trim();
  const cached = readResolvedRemoteAvatar(normalized);
  if (cached) return Promise.resolve(cached);
  const inFlight = inFlightRemoteAvatars.get(normalized);
  if (inFlight) return inFlight;
  const request = invoke<string>('desktop_fetch_remote_image_data_url', { url: normalized })
    .then((dataUrl) => {
      inFlightRemoteAvatars.delete(normalized);
      rememberResolvedRemoteAvatar(normalized, dataUrl);
      return dataUrl;
    })
    .catch((error) => {
      inFlightRemoteAvatars.delete(normalized);
      throw error;
    });
  inFlightRemoteAvatars.set(normalized, request);
  return request;
}

export function clearRemoteAvatarImageCacheForTests(): void {
  resolvedRemoteAvatars.clear();
  inFlightRemoteAvatars.clear();
  resolvedRemoteAvatarBytes = 0;
}

export function getRemoteAvatarImageCacheStatsForTests(): {
  entries: number;
  inFlight: number;
  totalBytes: number;
  maxBytes: number;
  maxEntries: number;
} {
  return {
    entries: resolvedRemoteAvatars.size,
    inFlight: inFlightRemoteAvatars.size,
    totalBytes: resolvedRemoteAvatarBytes,
    maxBytes: MAX_CACHED_REMOTE_AVATAR_BYTES,
    maxEntries: MAX_CACHED_REMOTE_AVATARS,
  };
}

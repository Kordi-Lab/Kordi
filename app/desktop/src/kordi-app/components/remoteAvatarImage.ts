import { useCallback, useEffect, useSyncExternalStore } from 'react';

type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export type RemoteImageNativeOptions = {
  command?: 'desktop_fetch_remote_image_data_url' | 'desktop_fetch_blob_emoji_data_url';
  expectedSha256?: string;
};

const DEFAULT_REMOTE_IMAGE_COMMAND = 'desktop_fetch_remote_image_data_url';

export type RemoteAvatarImageSnapshot =
  | { status: 'idle'; dataUrl: null; error: null }
  | { status: 'pending'; dataUrl: null; error: null }
  | { status: 'ready'; dataUrl: string; error: null }
  | { status: 'failed'; dataUrl: null; error: unknown };

const MAX_CACHED_REMOTE_AVATARS = 64;
const MAX_CACHED_REMOTE_AVATAR_BYTES = 16 * 1024 * 1024;
const MAX_FAILED_REMOTE_AVATARS = 64;
const FAILED_REMOTE_AVATAR_RETRY_COOLDOWN_MS = 30_000;
const IDLE_REMOTE_AVATAR_SNAPSHOT: RemoteAvatarImageSnapshot = Object.freeze({
  status: 'idle',
  dataUrl: null,
  error: null,
});
const PENDING_REMOTE_AVATAR_SNAPSHOT: RemoteAvatarImageSnapshot = Object.freeze({
  status: 'pending',
  dataUrl: null,
  error: null,
});

type RemoteAvatarCacheEntry = {
  dataUrl: string;
  estimatedBytes: number;
  snapshot: RemoteAvatarImageSnapshot;
};
type FailedRemoteAvatarEntry = {
  failedAt: number;
  error: unknown;
  snapshot: RemoteAvatarImageSnapshot;
};

const resolvedRemoteAvatars = new Map<string, RemoteAvatarCacheEntry>();
const inFlightRemoteAvatars = new Map<string, Promise<string>>();
const pendingRemoteAvatars = new Set<string>();
const failedRemoteAvatars = new Map<string, FailedRemoteAvatarEntry>();
const remoteAvatarListeners = new Map<string, Set<() => void>>();
let resolvedRemoteAvatarBytes = 0;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function normalizeRemoteAvatarUrl(imageUrl: string | null | undefined): string {
  return imageUrl?.trim() ?? '';
}

export function shouldLoadRemoteImageThroughNativeProxy(
  imageUrl: string | null | undefined,
  tauriRuntime = isTauriRuntime(),
): boolean {
  if (!tauriRuntime) return false;
  return normalizeRemoteAvatarUrl(imageUrl).startsWith('https://');
}

export const shouldLoadAvatarThroughNativeProxy = shouldLoadRemoteImageThroughNativeProxy;

function remoteImageRequestKey(
  imageUrl: string,
  options: RemoteImageNativeOptions = {},
): string {
  return [
    options.command ?? DEFAULT_REMOTE_IMAGE_COMMAND,
    options.expectedSha256?.trim().toLowerCase() ?? '',
    imageUrl,
  ].join('\u0000');
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

function notifyRemoteAvatarListeners(url: string): void {
  remoteAvatarListeners.get(url)?.forEach((listener) => listener());
}

function subscribeRemoteAvatar(url: string, listener: () => void): () => void {
  if (!url) return () => {};
  const listeners = remoteAvatarListeners.get(url) ?? new Set<() => void>();
  listeners.add(listener);
  remoteAvatarListeners.set(url, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) remoteAvatarListeners.delete(url);
  };
}

function readResolvedRemoteAvatar(url: string, touch: boolean): string | null {
  const cached = resolvedRemoteAvatars.get(url);
  if (!cached) return null;
  if (touch) {
    resolvedRemoteAvatars.delete(url);
    resolvedRemoteAvatars.set(url, cached);
  }
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

  resolvedRemoteAvatars.set(url, {
    dataUrl,
    estimatedBytes,
    snapshot: Object.freeze({ status: 'ready', dataUrl, error: null }),
  });
  resolvedRemoteAvatarBytes += estimatedBytes;
}

function rememberFailedRemoteAvatar(url: string, error: unknown): void {
  failedRemoteAvatars.delete(url);
  while (failedRemoteAvatars.size >= MAX_FAILED_REMOTE_AVATARS) {
    const oldestUrl = failedRemoteAvatars.keys().next().value as string | undefined;
    if (!oldestUrl) break;
    failedRemoteAvatars.delete(oldestUrl);
  }
  failedRemoteAvatars.set(url, {
    failedAt: Date.now(),
    error,
    snapshot: Object.freeze({ status: 'failed', dataUrl: null, error }),
  });
}

export function getRemoteImageSnapshot(
  imageUrl: string | null | undefined,
  options: RemoteImageNativeOptions = {},
): RemoteAvatarImageSnapshot {
  const normalized = normalizeRemoteAvatarUrl(imageUrl);
  if (!normalized) return IDLE_REMOTE_AVATAR_SNAPSHOT;
  const key = remoteImageRequestKey(normalized, options);
  const resolved = resolvedRemoteAvatars.get(key);
  if (resolved) return resolved.snapshot;
  if (pendingRemoteAvatars.has(key)) return PENDING_REMOTE_AVATAR_SNAPSHOT;
  return failedRemoteAvatars.get(key)?.snapshot ?? IDLE_REMOTE_AVATAR_SNAPSHOT;
}

export function getRemoteAvatarImageSnapshot(
  imageUrl: string | null | undefined,
): RemoteAvatarImageSnapshot {
  return getRemoteImageSnapshot(imageUrl);
}

export function loadRemoteImageThroughNativeProxy(
  imageUrl: string,
  options: RemoteImageNativeOptions = {},
  invoke: NativeInvoke = defaultNativeInvoke,
): Promise<string> {
  const normalized = normalizeRemoteAvatarUrl(imageUrl);
  if (!normalized) return Promise.reject(new Error('Avatar image URL is empty.'));
  const key = remoteImageRequestKey(normalized, options);

  const cached = readResolvedRemoteAvatar(key, true);
  if (cached) return Promise.resolve(cached);
  const inFlight = inFlightRemoteAvatars.get(key);
  if (inFlight) return inFlight;

  const failed = failedRemoteAvatars.get(key);
  if (
    failed
    && Date.now() - failed.failedAt < FAILED_REMOTE_AVATAR_RETRY_COOLDOWN_MS
  ) {
    return Promise.reject(failed.error);
  }
  failedRemoteAvatars.delete(key);
  pendingRemoteAvatars.add(key);
  notifyRemoteAvatarListeners(key);

  const command = options.command ?? DEFAULT_REMOTE_IMAGE_COMMAND;
  const args: Record<string, unknown> = { url: normalized };
  if (options.expectedSha256) args.expectedSha256 = options.expectedSha256;

  const request = Promise.resolve()
    .then(() => invoke<string>(command, args))
    .then((dataUrl) => {
      inFlightRemoteAvatars.delete(key);
      pendingRemoteAvatars.delete(key);
      rememberResolvedRemoteAvatar(key, dataUrl);
      notifyRemoteAvatarListeners(key);
      return dataUrl;
    })
    .catch((error: unknown) => {
      inFlightRemoteAvatars.delete(key);
      pendingRemoteAvatars.delete(key);
      rememberFailedRemoteAvatar(key, error);
      notifyRemoteAvatarListeners(key);
      throw error;
    });
  inFlightRemoteAvatars.set(key, request);
  return request;
}

export function loadAvatarThroughNativeProxy(
  imageUrl: string,
  invoke: NativeInvoke = defaultNativeInvoke,
): Promise<string> {
  return loadRemoteImageThroughNativeProxy(imageUrl, {}, invoke);
}

export function useRemoteImage(
  imageUrl: string | null | undefined,
  enabled: boolean,
  options: RemoteImageNativeOptions = {},
): RemoteAvatarImageSnapshot {
  const normalized = enabled ? normalizeRemoteAvatarUrl(imageUrl) : '';
  const command = options.command ?? DEFAULT_REMOTE_IMAGE_COMMAND;
  const expectedSha256 = options.expectedSha256;
  const key = normalized
    ? remoteImageRequestKey(normalized, { command, expectedSha256 })
    : '';
  const subscribe = useCallback(
    (listener: () => void) => subscribeRemoteAvatar(key, listener),
    [key],
  );
  const getSnapshot = useCallback(
    () => getRemoteImageSnapshot(normalized, { command, expectedSha256 }),
    [command, expectedSha256, normalized],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!normalized || snapshot.status !== 'idle') return;
    void loadRemoteImageThroughNativeProxy(normalized, { command, expectedSha256 }).catch(() => {
      // Native validation and loading failures are represented by the shared
      // failed snapshot. Never fall back to loading the HTTPS URL in WebView.
    });
  }, [command, expectedSha256, normalized, snapshot.status]);

  useEffect(() => {
    if (!key || snapshot.status !== 'failed' || typeof window === 'undefined') return;
    const retry = () => {
      failedRemoteAvatars.delete(key);
      notifyRemoteAvatarListeners(key);
    };
    window.addEventListener('online', retry, { once: true });
    return () => window.removeEventListener('online', retry);
  }, [key, snapshot.status]);

  return snapshot;
}

export function useRemoteAvatarImage(
  imageUrl: string | null | undefined,
  enabled: boolean,
): RemoteAvatarImageSnapshot {
  return useRemoteImage(imageUrl, enabled);
}

export function clearRemoteAvatarImageCacheForTests(): void {
  const affectedUrls = new Set([
    ...resolvedRemoteAvatars.keys(),
    ...pendingRemoteAvatars,
    ...failedRemoteAvatars.keys(),
  ]);
  resolvedRemoteAvatars.clear();
  inFlightRemoteAvatars.clear();
  pendingRemoteAvatars.clear();
  failedRemoteAvatars.clear();
  resolvedRemoteAvatarBytes = 0;
  affectedUrls.forEach(notifyRemoteAvatarListeners);
}

export function getRemoteAvatarImageCacheStatsForTests(): {
  entries: number;
  inFlight: number;
  failed: number;
  totalBytes: number;
  maxBytes: number;
  maxEntries: number;
} {
  return {
    entries: resolvedRemoteAvatars.size,
    inFlight: inFlightRemoteAvatars.size,
    failed: failedRemoteAvatars.size,
    totalBytes: resolvedRemoteAvatarBytes,
    maxBytes: MAX_CACHED_REMOTE_AVATAR_BYTES,
    maxEntries: MAX_CACHED_REMOTE_AVATARS,
  };
}

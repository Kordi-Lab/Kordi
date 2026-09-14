import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { avatarMemoryCache, remoteImageMemoryCache, remoteImageMemoryCaches } from './remoteImageMemoryCache';

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

type FailedRemoteAvatarEntry = {
  failedAt: number;
  error: unknown;
  snapshot: RemoteAvatarImageSnapshot;
};

const inFlightRemoteAvatars = new Map<string, Promise<string>>();
const pendingRemoteAvatars = new Set<string>();
const failedRemoteAvatars = new Map<string, FailedRemoteAvatarEntry>();
const remoteAvatarListeners = new Map<string, Set<() => void>>();

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function normalizeRemoteAvatarUrl(imageUrl: string | null | undefined): string {
  return imageUrl?.trim() ?? '';
}

export function shouldLoadRemoteImageThroughNativeProxy(
  imageUrl: string | null | undefined,
  tauriRuntime = isTauriRuntime(),
  allowDebugLoopback = false,
  development = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV),
): boolean {
  if (!tauriRuntime) return false;
  const normalized = normalizeRemoteAvatarUrl(imageUrl);
  if (normalized.startsWith('https://')) return true;
  if (!allowDebugLoopback || !development) return false;
  try {
    const url = new URL(normalized);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
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

function readResolvedRemoteAvatar(key: string, touch: boolean): string | null {
  const cache = remoteImageMemoryCache(key);
  const cached = cache.entries.get(key);
  if (!cached) return null;
  if (touch) cache.touch(key);
  return cached.dataUrl;
}

function rememberResolvedRemoteAvatar(key: string, dataUrl: string): void {
  remoteImageMemoryCache(key).remember(key, dataUrl);
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
  const resolved = remoteImageMemoryCache(key).entries.get(key);
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
    ...remoteImageMemoryCaches.flatMap(cache => [...cache.entries.keys()]),
    ...pendingRemoteAvatars,
    ...failedRemoteAvatars.keys(),
  ]);
  remoteImageMemoryCaches.forEach(cache => cache.clear());
  inFlightRemoteAvatars.clear();
  pendingRemoteAvatars.clear();
  failedRemoteAvatars.clear();
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
    entries: avatarMemoryCache.entries.size,
    inFlight: inFlightRemoteAvatars.size,
    failed: failedRemoteAvatars.size,
    totalBytes: avatarMemoryCache.totalBytes,
    maxBytes: avatarMemoryCache.maxBytes,
    maxEntries: avatarMemoryCache.maxEntries,
  };
}

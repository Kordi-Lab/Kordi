import { useCallback, useEffect, useSyncExternalStore } from 'react';

type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

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

export function shouldLoadAvatarThroughNativeProxy(
  imageUrl: string | null | undefined,
  tauriRuntime = isTauriRuntime(),
): boolean {
  if (!tauriRuntime) return false;
  return normalizeRemoteAvatarUrl(imageUrl).startsWith('https://');
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

export function getRemoteAvatarImageSnapshot(
  imageUrl: string | null | undefined,
): RemoteAvatarImageSnapshot {
  const normalized = normalizeRemoteAvatarUrl(imageUrl);
  if (!normalized) return IDLE_REMOTE_AVATAR_SNAPSHOT;
  const resolved = resolvedRemoteAvatars.get(normalized);
  if (resolved) return resolved.snapshot;
  if (pendingRemoteAvatars.has(normalized)) return PENDING_REMOTE_AVATAR_SNAPSHOT;
  return failedRemoteAvatars.get(normalized)?.snapshot ?? IDLE_REMOTE_AVATAR_SNAPSHOT;
}

export function loadAvatarThroughNativeProxy(
  imageUrl: string,
  invoke: NativeInvoke = defaultNativeInvoke,
): Promise<string> {
  const normalized = normalizeRemoteAvatarUrl(imageUrl);
  if (!normalized) return Promise.reject(new Error('Avatar image URL is empty.'));

  const cached = readResolvedRemoteAvatar(normalized, true);
  if (cached) return Promise.resolve(cached);
  const inFlight = inFlightRemoteAvatars.get(normalized);
  if (inFlight) return inFlight;

  const failed = failedRemoteAvatars.get(normalized);
  if (
    failed
    && Date.now() - failed.failedAt < FAILED_REMOTE_AVATAR_RETRY_COOLDOWN_MS
  ) {
    return Promise.reject(failed.error);
  }
  failedRemoteAvatars.delete(normalized);
  pendingRemoteAvatars.add(normalized);
  notifyRemoteAvatarListeners(normalized);

  const request = Promise.resolve()
    .then(() => invoke<string>('desktop_fetch_remote_image_data_url', { url: normalized }))
    .then((dataUrl) => {
      inFlightRemoteAvatars.delete(normalized);
      pendingRemoteAvatars.delete(normalized);
      rememberResolvedRemoteAvatar(normalized, dataUrl);
      notifyRemoteAvatarListeners(normalized);
      return dataUrl;
    })
    .catch((error: unknown) => {
      inFlightRemoteAvatars.delete(normalized);
      pendingRemoteAvatars.delete(normalized);
      rememberFailedRemoteAvatar(normalized, error);
      notifyRemoteAvatarListeners(normalized);
      throw error;
    });
  inFlightRemoteAvatars.set(normalized, request);
  return request;
}

export function useRemoteAvatarImage(
  imageUrl: string | null | undefined,
  enabled: boolean,
): RemoteAvatarImageSnapshot {
  const normalized = enabled ? normalizeRemoteAvatarUrl(imageUrl) : '';
  const subscribe = useCallback(
    (listener: () => void) => subscribeRemoteAvatar(normalized, listener),
    [normalized],
  );
  const getSnapshot = useCallback(
    () => getRemoteAvatarImageSnapshot(normalized),
    [normalized],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!normalized || snapshot.status === 'ready' || snapshot.status === 'pending') return;
    void loadAvatarThroughNativeProxy(normalized).catch(() => {
      // Native validation and loading failures are represented by the shared
      // failed snapshot. Never fall back to loading the HTTPS URL in WebView.
    });
  }, [normalized, snapshot.status]);

  return snapshot;
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

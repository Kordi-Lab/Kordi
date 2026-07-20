type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const MAX_CACHED_REMOTE_AVATARS = 256;
const remoteAvatarPromises = new Map<string, Promise<string>>();

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

function rememberRemoteAvatar(url: string, promise: Promise<string>): Promise<string> {
  remoteAvatarPromises.set(url, promise);
  if (remoteAvatarPromises.size > MAX_CACHED_REMOTE_AVATARS) {
    const oldest = remoteAvatarPromises.keys().next().value;
    if (oldest) remoteAvatarPromises.delete(oldest);
  }
  return promise;
}

export function loadAvatarThroughNativeProxy(
  imageUrl: string,
  invoke: NativeInvoke = defaultNativeInvoke,
): Promise<string> {
  const normalized = imageUrl.trim();
  const cached = remoteAvatarPromises.get(normalized);
  if (cached) return cached;
  const request = invoke<string>('desktop_fetch_remote_image_data_url', { url: normalized })
    .catch((error) => {
      remoteAvatarPromises.delete(normalized);
      throw error;
    });
  return rememberRemoteAvatar(normalized, request);
}

export function clearRemoteAvatarImageCacheForTests(): void {
  remoteAvatarPromises.clear();
}

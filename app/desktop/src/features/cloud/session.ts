// Persistent storage for the hosted account session token.
//
// Inside Tauri (the production runtime), the session is stored in the OS
// keychain via the cloud_session_* Tauri commands. Outside Tauri (Vite browser
// preview, unit tests) we fall back to a memory-only stub and emit one console
// warning so devs notice the security degradation.

export type StoredSession = {
  token: string;
  accountId: string;
  expiresAt: string;
  deviceId?: string;
};

export interface SessionStorageBackend {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

export const CLOUD_SESSION_SIGNED_OUT_EVENT = 'kordi-cloud-session-signed-out';

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

class TauriKeychainBackend implements SessionStorageBackend {
  async load(): Promise<StoredSession | null> {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<StoredSession | null>('cloud_session_load');
    return result ?? null;
  }

  async save(session: StoredSession): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cloud_session_store', {
      token: session.token,
      accountId: session.accountId,
      expiresAt: session.expiresAt,
      deviceId: session.deviceId,
    });
  }

  async clear(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cloud_session_clear');
  }
}

class MemoryBackend implements SessionStorageBackend {
  private cached: StoredSession | null = null;
  private warned = false;

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    if (typeof console !== 'undefined') {
      console.warn(
        '[kordi] Cloud session is using an in-memory fallback because the Tauri ' +
          'keychain backend is unavailable. Restarting the app will sign you out.',
      );
    }
  }

  async load(): Promise<StoredSession | null> {
    this.warnOnce();
    return this.cached;
  }

  async save(session: StoredSession): Promise<void> {
    this.warnOnce();
    this.cached = { ...session };
  }

  async clear(): Promise<void> {
    this.cached = null;
  }
}

let backendOverride: SessionStorageBackend | null = null;
let cachedBackend: SessionStorageBackend | null = null;
let cachedSessionValue: StoredSession | null | undefined;
let cachedSessionLoadPromise: Promise<StoredSession | null> | null = null;

function resetSessionLoadCache(): void {
  cachedSessionValue = undefined;
  cachedSessionLoadPromise = null;
}

export function __setSessionBackendForTests(backend: SessionStorageBackend | null): void {
  backendOverride = backend;
  cachedBackend = null;
  resetSessionLoadCache();
}

function backend(): SessionStorageBackend {
  if (backendOverride) return backendOverride;
  if (cachedBackend) return cachedBackend;
  cachedBackend = isTauriRuntime() ? new TauriKeychainBackend() : new MemoryBackend();
  return cachedBackend;
}

export async function loadSession(): Promise<StoredSession | null> {
  if (cachedSessionValue !== undefined) return cachedSessionValue;
  if (!cachedSessionLoadPromise) {
    cachedSessionLoadPromise = backend().load()
      .then((session) => {
        cachedSessionValue = session ?? null;
        return cachedSessionValue;
      })
      .catch((error) => {
        resetSessionLoadCache();
        throw error;
      })
      .finally(() => {
        cachedSessionLoadPromise = null;
      });
  }
  return cachedSessionLoadPromise;
}

export async function saveSession(session: StoredSession): Promise<void> {
  await backend().save(session);
  cachedSessionValue = { ...session };
  cachedSessionLoadPromise = null;
}

export async function clearSession(): Promise<void> {
  await backend().clear();
  cachedSessionValue = null;
  cachedSessionLoadPromise = null;
}

export function notifyCloudSessionSignedOut(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(CLOUD_SESSION_SIGNED_OUT_EVENT));
}

export async function clearSessionAndNotifySignedOut(): Promise<void> {
  await clearSession();
  notifyCloudSessionSignedOut();
}

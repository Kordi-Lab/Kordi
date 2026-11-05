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
  /** Browser sign-in only: rotating refresh token, client ID and the issuing token endpoint. */
  refreshToken?: string;
  clientId?: string;
  tokenEndpoint?: string;
  /** The organization the access token acts in, once a switch recorded it. */
  organizationId?: string;
};

export interface SessionStorageBackend {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
  /** Refreshes a browser sign-in session; rejects with a stable code such as `invalid_grant`. */
  refresh?(session: StoredSession): Promise<StoredSession>;
  /**
   * Exchanges the access token for one bound to another organization and
   * saves it only while the stored session is still `session`. Rejects with a
   * stable code such as `session_changed` or `organization_not_found`.
   */
  switchOrganization?(session: StoredSession, organizationId: string): Promise<StoredSession>;
}

/** Browser sign-in access tokens last an hour; refresh this long before expiry. */
export const CLOUD_SESSION_REFRESH_MARGIN_MS = 5 * 60_000;

export const CLOUD_SESSION_SIGNED_OUT_EVENT = 'kordi-cloud-session-signed-out';
export const CLOUD_SESSION_CHANGED_EVENT = 'kordi-cloud-session-changed';

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
      refreshToken: session.refreshToken,
      clientId: session.clientId,
      tokenEndpoint: session.tokenEndpoint,
    });
  }

  async refresh(session: StoredSession): Promise<StoredSession> {
    // The native shell serializes refreshes across every window and task.
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<StoredSession>('cloud_session_refresh', { previousToken: session.token });
  }

  async switchOrganization(session: StoredSession, organizationId: string): Promise<StoredSession> {
    // The native shell saves the switched token with a compare-and-swap.
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<StoredSession>('cloud_session_switch_organization', { previousToken: session.token, organizationId });
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

  async refresh(session: StoredSession): Promise<StoredSession> {
    const [{ refreshAppSession }, { cloudFetchImpl }] = await Promise.all([
      import('./appSignIn/appSignInClient'),
      import('./cloudTransport'),
    ]);
    const next = await refreshAppSession(session, cloudFetchImpl());
    this.cached = { ...next };
    return next;
  }

  async switchOrganization(session: StoredSession, organizationId: string): Promise<StoredSession> {
    const [{ exchangeOrganizationToken }, { baseCloudFetchImpl }, { cloudApiBaseUrl }] = await Promise.all([
      import('@/features/organizations/organizationToken'),
      import('./cloudTransport'),
      import('./cloudApiEnvironment'),
    ]);
    const next = await exchangeOrganizationToken(session, organizationId, baseCloudFetchImpl(), cloudApiBaseUrl());
    if (!isSameStoredSession(this.cached, session)) throw new Error(this.cached ? 'session_changed' : 'not_signed_in');
    this.cached = { ...next };
    return next;
  }
}

/** Whether `current` is still the session `start` (same account and refresh token, or the same token). */
export function isSameStoredSession(current: StoredSession | null, start: StoredSession): boolean {
  if (!current || current.accountId !== start.accountId) return false;
  return start.refreshToken ? current.refreshToken === start.refreshToken : !current.refreshToken && current.token === start.token;
}

let backendOverride: SessionStorageBackend | null = null;
let cachedBackend: SessionStorageBackend | null = null;
let cachedSessionValue: StoredSession | null | undefined;
let cachedSessionLoadPromise: Promise<StoredSession | null> | null = null;
let sessionRevision = 0;
let refreshInFlight: Promise<StoredSession | null> | null = null;
let switchInFlight: { organizationId: string; promise: Promise<StoredSession> } | null = null;

function resetSessionLoadCache(): void {
  sessionRevision += 1;
  cachedSessionValue = undefined;
  cachedSessionLoadPromise = null;
}

export function __setSessionBackendForTests(backend: SessionStorageBackend | null): void {
  backendOverride = backend;
  cachedBackend = null;
  refreshInFlight = null;
  switchInFlight = null;
  resetSessionLoadCache();
}

function backend(): SessionStorageBackend {
  if (backendOverride) return backendOverride;
  if (cachedBackend) return cachedBackend;
  cachedBackend = isTauriRuntime() ? new TauriKeychainBackend() : new MemoryBackend();
  return cachedBackend;
}

export function sessionNeedsRefresh(
  session: StoredSession | null,
  now = Date.now(),
  marginMs = CLOUD_SESSION_REFRESH_MARGIN_MS,
): boolean {
  if (!session?.refreshToken) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt - now <= marginMs;
}

function refreshErrorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refreshes a browser sign-in session once, however many callers ask at the
 * same time. A refused refresh token ends the session; other failures keep
 * it so a later call can retry.
 */
export function refreshSession(session: StoredSession): Promise<StoredSession | null> {
  if (refreshInFlight) return refreshInFlight;
  const store = backend();
  if (!session.refreshToken || !store.refresh) return Promise.resolve(session);
  const revision = sessionRevision;
  refreshInFlight = store.refresh(session)
    .then((next) => {
      if (revision !== sessionRevision) return cachedSessionValue ?? null;
      cachedSessionValue = { ...next };
      cachedSessionLoadPromise = null;
      return cachedSessionValue;
    })
    .catch(async (error: unknown) => {
      const code = refreshErrorCode(error);
      if (code === 'invalid_grant' || code === 'not_signed_in') {
        if (revision === sessionRevision) await clearSessionAndNotifySignedOut();
        return null;
      }
      return session;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/** The session this window last loaded, without reading storage. */
export function cachedSessionSnapshot(): StoredSession | null {
  return cachedSessionValue ?? null;
}

/**
 * Switches the stored session's access token to `organizationId`, once
 * however many callers ask. The account, sign-in and refresh token stay the
 * same. When another window refreshed or switched first, retries once from
 * the stored session of the same account. Rejects with a stable code.
 */
export function switchSessionOrganization(organizationId: string): Promise<StoredSession> {
  if (switchInFlight?.organizationId === organizationId) return switchInFlight.promise;
  const promise = runOrganizationSwitch(organizationId).finally(() => {
    if (switchInFlight?.promise === promise) switchInFlight = null;
  });
  switchInFlight = { organizationId, promise };
  return promise;
}

async function runOrganizationSwitch(organizationId: string): Promise<StoredSession> {
  const store = backend();
  if (!store.switchOrganization) throw new Error('unsupported');
  let session = await loadSession();
  if (!session) throw new Error('not_signed_in');
  for (let attempt = 0; ; attempt += 1) {
    const revision = sessionRevision;
    try {
      const next = await store.switchOrganization(session, organizationId);
      if (revision === sessionRevision) {
        cachedSessionValue = { ...next };
        cachedSessionLoadPromise = null;
      }
      return next;
    } catch (error) {
      if (attempt > 0 || refreshErrorCode(error) !== 'session_changed' || revision !== sessionRevision) throw error;
      resetSessionLoadCache();
      const current = await loadSession();
      if (!current || current.accountId !== session.accountId) throw error;
      session = current;
    }
  }
}

/** The stored session, refreshed first when a browser sign-in token is about to expire. */
export async function loadSession(): Promise<StoredSession | null> {
  const session = await loadStoredSession();
  return sessionNeedsRefresh(session) && session ? refreshSession(session) : session;
}

async function loadStoredSession(): Promise<StoredSession | null> {
  if (cachedSessionValue !== undefined) return cachedSessionValue;
  if (!cachedSessionLoadPromise) {
    const revision = sessionRevision;
    cachedSessionLoadPromise = backend().load()
      .then((session) => {
        if (revision !== sessionRevision) return cachedSessionValue ?? null;
        cachedSessionValue = session ?? null;
        return cachedSessionValue;
      })
      .catch((error) => {
        if (revision === sessionRevision) resetSessionLoadCache();
        throw error;
      })
      .finally(() => {
        if (revision === sessionRevision) cachedSessionLoadPromise = null;
      });
  }
  return cachedSessionLoadPromise;
}

export async function saveSession(session: StoredSession): Promise<void> {
  const revision = ++sessionRevision;
  const previousAccountId = cachedSessionValue?.accountId;
  try { await backend().save(session); }
  catch (error) {
    if (revision === sessionRevision) resetSessionLoadCache();
    throw error;
  }
  if (revision !== sessionRevision) return;
  cachedSessionValue = { ...session };
  cachedSessionLoadPromise = null;
  if (previousAccountId !== session.accountId && typeof window !== 'undefined') window.dispatchEvent(new Event(CLOUD_SESSION_CHANGED_EVENT));
}

export async function clearSession(): Promise<void> {
  const revision = ++sessionRevision;
  cachedSessionValue = null;
  cachedSessionLoadPromise = null;
  await backend().clear();
  if (revision !== sessionRevision) return;
  cachedSessionValue = null;
  cachedSessionLoadPromise = null;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CLOUD_SESSION_CHANGED_EVENT));
}

export function notifyCloudSessionSignedOut(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(CLOUD_SESSION_SIGNED_OUT_EVENT));
}

export async function clearSessionAndNotifySignedOut(): Promise<void> {
  await clearSession();
  notifyCloudSessionSignedOut();
}

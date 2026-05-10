// Auto-register a cloud account's desktop device with the bridges network.
// On first login the OS keychain has no device keypair, so we generate one,
// derive the matching x25519 public key, and ask the cloud server to register
// us as a bridges node. The bridges api_key returned by that call is stored
// alongside the session token for subsequent bridges-protocol calls.

import { CloudAuthClient, CloudAuthError } from './authClient';

export type CloudDeviceKeypair = {
  ed25519Pubkey: string;
  x25519Pubkey: string;
};

export type EnsureDeviceRegisteredOptions = {
  accountId: string;
  sessionToken: string;
  client?: CloudAuthClient;
};

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

async function loadOrCreateKeypair(accountId: string): Promise<CloudDeviceKeypair> {
  if (!isTauriRuntime()) {
    throw new Error('cloud_device_registration_requires_tauri');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<CloudDeviceKeypair>('cloud_device_keypair_load_or_create', { accountId });
}

async function loadStoredApiKey(accountId: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const value = await invoke<string | null>('cloud_bridges_api_key_load', { accountId });
  return value ?? null;
}

async function persistApiKey(accountId: string, apiKey: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('cloud_bridges_api_key_store', { accountId, apiKey });
}

export type EnsureDeviceRegisteredResult = {
  /** Bridges node id derived from the device's ed25519 public key. */
  nodeId: string | null;
  /** Bridges api key for this device. May come from cache. */
  apiKey: string | null;
};

/**
 * Idempotent: a re-registration for an already-known device produces a fresh
 * api key on the server side and we update the keychain entry. Callers can
 * always rely on `apiKey` being usable when the result resolves successfully.
 */
export async function ensureCloudDeviceRegistered({
  accountId,
  sessionToken,
  client,
}: EnsureDeviceRegisteredOptions): Promise<EnsureDeviceRegisteredResult> {
  if (!isTauriRuntime()) {
    return { nodeId: null, apiKey: null };
  }

  const keypair = await loadOrCreateKeypair(accountId);
  const authClient = client ?? new CloudAuthClient();

  try {
    const result = await authClient.registerDevice(sessionToken, {
      ed25519Pubkey: keypair.ed25519Pubkey,
      x25519Pubkey: keypair.x25519Pubkey,
    });
    await persistApiKey(accountId, result.apiKey);
    return { nodeId: result.nodeId, apiKey: result.apiKey };
  } catch (caught) {
    // If the network is down, fall back to the cached key so the rest of
    // the app can keep functioning offline. Re-throw auth errors so the UI
    // can show them.
    if (caught instanceof CloudAuthError && caught.code === 'network_error') {
      const cached = await loadStoredApiKey(accountId);
      return { nodeId: null, apiKey: cached };
    }
    throw caught;
  }
}

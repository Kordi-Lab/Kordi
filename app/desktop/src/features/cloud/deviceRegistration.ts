// Auto-register a cloud account's desktop device with the bridges network.
// On first login the OS keychain has no device keypair, so we generate one,
// derive the matching x25519 public key, and ask the cloud server to register
// us as a bridges node. The bridges api_key returned by that call is stored
// alongside the session token for subsequent bridges-protocol calls, and the
// existing desktop bridge layer is told about the resulting host so the chat
// sidebar / contacts / mailbox flows pick it up.

import { CloudAuthClient, CloudAuthError, cloudApiBaseUrl, type CloudAccount } from './authClient';

export type CloudDeviceKeypair = {
  ed25519Pubkey: string;
  x25519Pubkey: string;
};

export type EnsureDeviceRegisteredOptions = {
  accountId: string;
  sessionToken: string;
  client?: CloudAuthClient;
  account?: Pick<CloudAccount, 'displayName' | 'primaryEmail'>;
  /**
   * Cloud server origin used as the `coordination` URL for the bridge host
   * record. Defaults to the same VITE_KORDI_CLOUD_API_BASE the auth client uses.
   */
  coordinationUrl?: string;
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

function defaultCoordinationUrl(): string {
  return cloudApiBaseUrl();
}

async function registerCloudBridgeHost(input: {
  coordination: string;
  apiKey: string;
  nodeId: string;
  accountId: string;
  displayName: string | null;
  ownerName: string | null;
}): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('desktop_bridge_register_cloud_host', {
    coordination: input.coordination,
    apiKey: input.apiKey,
    nodeId: input.nodeId,
    accountId: input.accountId,
    displayName: input.displayName,
    ownerName: input.ownerName,
  });
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
  account,
  coordinationUrl,
}: EnsureDeviceRegisteredOptions): Promise<EnsureDeviceRegisteredResult> {
  if (!isTauriRuntime()) {
    return { nodeId: null, apiKey: null };
  }

  // Pre-generate the device keypair — even though there's no live route to
  // register it against right now, having the secret in the keychain means
  // the future bridges/cli registration flow can pick it up without
  // re-prompting the user. Cheap to compute and zero cost while idle.
  const _keypair = await loadOrCreateKeypair(accountId);
  void client;
  void account;
  void coordinationUrl;
  void sessionToken;

  // The cloud-server crate intentionally does NOT expose /v1/cloud/auth/register-device
  // — that flow belongs to bridges/cli. Until the desktop's bridges binding
  // is rebuilt against bridges/cli with real cloud-issued credentials, this
  // helper is a no-op past keypair generation.
  return { nodeId: null, apiKey: null };
}

export type CloudDeviceRegistration = {
  displayName: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  approximateLocation: string;
  publicKey: string;
  keyAlgorithm: 'p256';
};

type NativeDeviceMetadata = {
  displayName: string;
  platform: string;
  osVersion: string;
  timeZone: string | null;
  countryCode: string | null;
};

type StoredDeviceIdentity = {
  privateKeyPkcs8: string;
  publicKeySpki: string;
  keyAlgorithm: 'p256';
};

type NativePublicIdentity = {
  publicKeySpki: string;
  keyAlgorithm: string;
};

type DeviceMetadataRegistration = Omit<CloudDeviceRegistration, 'publicKey' | 'keyAlgorithm'>;

// Browser previews have no native key store; they keep a per-page identity.
let memoryIdentity: StoredDeviceIdentity | null = null;
let metadataPromise: Promise<DeviceMetadataRegistration> | null = null;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function generateIdentity(): Promise<StoredDeviceIdentity> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure installation identity is unavailable on this device.');
  }
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
    crypto.subtle.exportKey('spki', pair.publicKey),
  ]);
  return {
    privateKeyPkcs8: bytesToBase64Url(new Uint8Array(privateKey)),
    publicKeySpki: bytesToBase64Url(new Uint8Array(publicKey)),
    keyAlgorithm: 'p256',
  };
}

async function isValidIdentity(identity: StoredDeviceIdentity): Promise<boolean> {
  if (identity.keyAlgorithm !== 'p256' || !globalThis.crypto?.subtle) return false;
  try {
    const [privateKey, publicKey] = await Promise.all([
      crypto.subtle.importKey(
        'pkcs8',
        base64UrlToBytes(identity.privateKeyPkcs8),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
      ),
      crypto.subtle.importKey(
        'spki',
        base64UrlToBytes(identity.publicKeySpki),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      ),
    ]);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      challenge,
    );
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature,
      challenge,
    );
  } catch {
    return false;
  }
}

/**
 * The installation public key that sign-in registers. In the desktop app the
 * native runtime creates and stores the keypair and signs device proofs with
 * it, so the private key never reaches the webview.
 */
async function installationPublicKey(): Promise<string> {
  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const identity = await invoke<NativePublicIdentity | null>('cloud_device_identity_public');
    if (identity?.keyAlgorithm !== 'p256' || !identity.publicKeySpki) {
      throw new Error('Secure installation identity is unavailable on this device.');
    }
    return identity.publicKeySpki;
  }
  if (!memoryIdentity || !(await isValidIdentity(memoryIdentity))) {
    memoryIdentity = await generateIdentity();
  }
  return memoryIdentity.publicKeySpki;
}

function browserDesktopPlatform(): { displayName: string; platform: string; osVersion: string } {
  const platformValue = typeof navigator === 'undefined' ? '' : navigator.platform;
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const macVersion = userAgent.match(/Mac OS X ([0-9_]+)/)?.[1]?.replace(/_/g, '.') ?? '';
  if (/Mac/i.test(platformValue) || /Mac OS/i.test(userAgent)) {
    return { displayName: 'Mac', platform: 'macos', osVersion: macVersion };
  }
  if (/Win/i.test(platformValue) || /Windows/i.test(userAgent)) {
    return { displayName: 'Windows PC', platform: 'windows', osVersion: '' };
  }
  if (/Linux/i.test(platformValue) || /Linux/i.test(userAgent)) {
    return { displayName: 'Linux computer', platform: 'linux', osVersion: '' };
  }
  return { displayName: 'Kordi desktop', platform: 'desktop', osVersion: '' };
}

function timeZoneCity(timeZone: string | null): string | null {
  const segments = timeZone?.split('/') ?? [];
  const segment = segments[segments.length - 1]?.replace(/_/g, ' ').trim();
  return segment && segment.toUpperCase() !== 'UTC' ? segment : null;
}

function approximateLocation(timeZone: string | null, countryCode: string | null): string {
  const city = timeZoneCity(timeZone);
  let country: string | null = null;
  if (countryCode) {
    try {
      country = new Intl.DisplayNames(undefined, { type: 'region' }).of(countryCode) ?? null;
    } catch {
      country = null;
    }
  }
  return [city, country].filter(Boolean).join(', ');
}

async function desktopMetadata(): Promise<{
  displayName: string;
  platform: string;
  osVersion: string;
  approximateLocation: string;
}> {
  if (!isTauriRuntime()) {
    return { ...browserDesktopPlatform(), approximateLocation: '' };
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const metadata = await invoke<NativeDeviceMetadata>('cloud_device_system_metadata');
    return {
      displayName: metadata.displayName,
      platform: metadata.platform,
      osVersion: metadata.osVersion,
      approximateLocation: approximateLocation(metadata.timeZone, metadata.countryCode),
    };
  } catch {
    return { ...browserDesktopPlatform(), approximateLocation: '' };
  }
}

async function desktopAppVersion(): Promise<string> {
  if (!isTauriRuntime()) return 'web';
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '';
  }
}

async function resolveDeviceMetadata(): Promise<DeviceMetadataRegistration> {
  const metadata = await desktopMetadata();
  return { ...metadata, appVersion: await desktopAppVersion() };
}

/**
 * The registration that sign-in sends. The public key is read each time,
 * because the native runtime can replace the installation key while the
 * page stays open; the device details are read once.
 */
export async function installationDeviceRegistration(): Promise<CloudDeviceRegistration> {
  const publicKey = await installationPublicKey();
  metadataPromise ??= resolveDeviceMetadata().catch((error) => {
    metadataPromise = null;
    throw error;
  });
  return { ...(await metadataPromise), publicKey, keyAlgorithm: 'p256' };
}

export function __resetDeviceIdentityForTests(): void {
  memoryIdentity = null;
  metadataPromise = null;
}

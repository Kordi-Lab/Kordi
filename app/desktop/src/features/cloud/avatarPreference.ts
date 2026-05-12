export const AVATAR_PREFERENCE_STORAGE_KEY = 'kordi.cloud.signupAvatar';
export const AVATAR_UPLOAD_MAX_BYTES = 200 * 1024;
export const CLOUD_SIGNUP_AVATAR_KEY = 'cloud-signup-preview';
const SEED_PREFIX = 'cloud-signup';

export type AvatarPreference =
  | { kind: 'seed'; seed: string }
  | { kind: 'upload'; dataUrl: string };

function resolveStorage(storage: Storage | undefined): Storage | null {
  if (storage) return storage;
  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  return candidate ?? null;
}

function fallbackSeedToken() {
  const stamp = Date.now().toString(36);
  const noise = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${stamp}-${noise}`;
}

export function randomAvatarSeed(rng?: { randomUUID?: () => string }): string {
  const generator = rng ?? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const uuid = typeof generator?.randomUUID === 'function' ? generator.randomUUID() : null;
  return `${SEED_PREFIX}:${uuid ?? fallbackSeedToken()}`;
}

export function readAvatarPreference(storage?: Storage): AvatarPreference | null {
  const target = resolveStorage(storage);
  if (!target) return null;

  const raw = target.getItem(AVATAR_PREFERENCE_STORAGE_KEY);
  if (raw == null) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<AvatarPreference> & { kind?: string };
    if (parsed?.kind === 'seed' && typeof parsed.seed === 'string' && parsed.seed.trim()) {
      return { kind: 'seed', seed: parsed.seed.trim() };
    }
    if (
      parsed?.kind === 'upload' &&
      typeof parsed.dataUrl === 'string' &&
      parsed.dataUrl.startsWith('data:') &&
      parsed.dataUrl.length <= AVATAR_UPLOAD_MAX_BYTES
    ) {
      return { kind: 'upload', dataUrl: parsed.dataUrl };
    }
  } catch {
    // Fall through to clear malformed entry.
  }

  target.removeItem(AVATAR_PREFERENCE_STORAGE_KEY);
  return null;
}

export function writeAvatarPreference(value: AvatarPreference, storage?: Storage): boolean {
  const target = resolveStorage(storage);
  if (!target) return false;

  if (value.kind === 'upload' && value.dataUrl.length > AVATAR_UPLOAD_MAX_BYTES) {
    return false;
  }
  if (value.kind === 'seed' && !value.seed.trim()) {
    return false;
  }

  const normalized: AvatarPreference =
    value.kind === 'seed' ? { kind: 'seed', seed: value.seed.trim() } : value;

  try {
    target.setItem(AVATAR_PREFERENCE_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function clearAvatarPreference(storage?: Storage): void {
  const target = resolveStorage(storage);
  target?.removeItem(AVATAR_PREFERENCE_STORAGE_KEY);
}

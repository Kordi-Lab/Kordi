export const AVATAR_PREFERENCE_STORAGE_KEY = 'kordi.cloud.signupAvatar';
export const AVATAR_UPLOAD_MAX_BYTES = 200 * 1024;

export type AvatarPreference = { kind: 'upload'; dataUrl: string };

const ALLOWED_AVATAR_DATA_URL_PREFIXES = [
  'data:image/png;base64,',
  'data:image/jpeg;base64,',
  'data:image/webp;base64,',
];

function resolveStorage(storage: Storage | undefined): Storage | null {
  if (storage) return storage;
  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  return candidate ?? null;
}

export function isAllowedAvatarDataUrl(value: string): boolean {
  return ALLOWED_AVATAR_DATA_URL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function dataUrlPayloadBytes(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',');
  const payload = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  const trimmed = payload.trimEnd().replace(/=+$/, '');
  return Math.floor((trimmed.length * 3) / 4);
}

function normalizedUploadPreference(value: unknown): AvatarPreference | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AvatarPreference> & { kind?: unknown; dataUrl?: unknown };
  if (
    candidate.kind === 'upload' &&
    typeof candidate.dataUrl === 'string' &&
    isAllowedAvatarDataUrl(candidate.dataUrl) &&
    dataUrlPayloadBytes(candidate.dataUrl) <= AVATAR_UPLOAD_MAX_BYTES
  ) {
    return { kind: 'upload', dataUrl: candidate.dataUrl };
  }
  return null;
}

export function readAvatarPreference(storage?: Storage): AvatarPreference | null {
  const target = resolveStorage(storage);
  if (!target) return null;

  const raw = target.getItem(AVATAR_PREFERENCE_STORAGE_KEY);
  if (raw == null) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizedUploadPreference(parsed);
    if (normalized) return normalized;
  } catch {
    // Fall through to clear malformed entry.
  }

  target.removeItem(AVATAR_PREFERENCE_STORAGE_KEY);
  return null;
}

export function writeAvatarPreference(value: AvatarPreference, storage?: Storage): boolean {
  const target = resolveStorage(storage);
  if (!target) return false;

  const normalized = normalizedUploadPreference(value);
  if (!normalized) return false;

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

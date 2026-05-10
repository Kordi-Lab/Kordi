import type { CloudLoginMode } from './loginWindow';

export const LOGIN_MODE_STORAGE_KEY = 'kordi.cloud.loginMode';

function resolveStorage(storage: Storage | undefined): Storage | null {
  if (storage) return storage;
  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  return candidate ?? null;
}

function isCloudLoginMode(value: unknown): value is CloudLoginMode {
  return value === 'login' || value === 'signup';
}

export function readLoginModePreference(storage?: Storage): CloudLoginMode | null {
  const target = resolveStorage(storage);
  if (!target) return null;

  const raw = target.getItem(LOGIN_MODE_STORAGE_KEY);
  if (!isCloudLoginMode(raw)) {
    if (raw != null) target.removeItem(LOGIN_MODE_STORAGE_KEY);
    return null;
  }
  return raw;
}

export function writeLoginModePreference(mode: CloudLoginMode, storage?: Storage): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(LOGIN_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore quota or access errors.
  }
}

export function clearLoginModePreference(storage?: Storage): void {
  const target = resolveStorage(storage);
  target?.removeItem(LOGIN_MODE_STORAGE_KEY);
}

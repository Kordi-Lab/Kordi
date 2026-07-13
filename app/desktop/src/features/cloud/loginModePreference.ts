import type { CloudLoginMode } from './loginWindow';
import {
  readPreferenceStorageItem,
  removePreferenceStorageItem,
  resolvePreferenceStorage,
  writePreferenceStorageItem,
} from './preferenceStorage';

export const LOGIN_MODE_STORAGE_KEY = 'kordi.cloud.loginMode';

function isCloudLoginMode(value: unknown): value is CloudLoginMode {
  return value === 'login' || value === 'signup';
}

export function readLoginModePreference(storage?: Storage): CloudLoginMode | null {
  const target = resolvePreferenceStorage(storage);
  if (!target) return null;

  const raw = readPreferenceStorageItem(target, LOGIN_MODE_STORAGE_KEY);
  if (!isCloudLoginMode(raw)) {
    if (raw != null) removePreferenceStorageItem(target, LOGIN_MODE_STORAGE_KEY);
    return null;
  }
  return raw;
}

export function writeLoginModePreference(mode: CloudLoginMode, storage?: Storage): void {
  const target = resolvePreferenceStorage(storage);
  if (!target) return;
  writePreferenceStorageItem(target, LOGIN_MODE_STORAGE_KEY, mode);
}

export function clearLoginModePreference(storage?: Storage): void {
  const target = resolvePreferenceStorage(storage);
  if (target) removePreferenceStorageItem(target, LOGIN_MODE_STORAGE_KEY);
}

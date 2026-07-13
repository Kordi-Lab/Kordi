function hasPreferenceStorageMethods(value: unknown): value is Storage {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const candidate = value as Partial<Storage>;
  return typeof candidate.getItem === 'function'
    && typeof candidate.setItem === 'function'
    && typeof candidate.removeItem === 'function';
}

export function resolvePreferenceStorage(storage?: Storage): Storage | null {
  try {
    const candidate = storage === undefined
      ? (globalThis as { localStorage?: unknown }).localStorage
      : storage;
    return hasPreferenceStorageMethods(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function readPreferenceStorageItem(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreferenceStorageItem(storage: Storage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removePreferenceStorageItem(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage is optional; inaccessible preferences are treated as absent.
  }
}

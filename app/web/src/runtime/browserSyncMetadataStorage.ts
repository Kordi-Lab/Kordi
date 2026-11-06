import { cachedSessionSnapshot, CLOUD_SESSION_CHANGED_EVENT, CLOUD_SESSION_SIGNED_OUT_EVENT } from '@/features/cloud/session';

const values = new Map<string, string>();
let initialized = false;
const scope = () => {
  const session = cachedSessionSnapshot();
  return JSON.stringify([session?.accountId ?? null, session?.organizationId ?? null]);
};
const storage: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  key: index => [...values.keys()][index] ?? null,
  getItem: key => values.get(`${scope()}:${key}`) ?? null,
  setItem: (key, value) => { values.set(`${scope()}:${key}`, value); },
  removeItem: key => { values.delete(`${scope()}:${key}`); },
};

/** Ephemeral metadata supports the shared catalog-readiness contract. Durable
 * content belongs only to the account + organization IndexedDB projection. */
export function browserSyncMetadataStorage(): Storage {
  if (!initialized && typeof window !== 'undefined') {
    initialized = true;
    const clear = () => values.clear();
    window.addEventListener(CLOUD_SESSION_CHANGED_EVENT, clear);
    window.addEventListener(CLOUD_SESSION_SIGNED_OUT_EVENT, clear);
  }
  return storage;
}

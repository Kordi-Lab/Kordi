import { resolvePreferenceStorage, readPreferenceStorageItem, writePreferenceStorageItem } from '@/features/cloud/preferenceStorage';

export type HelpProgress = { step: number; completed: boolean; welcome: boolean };
const emptyProgress = (): HelpProgress => ({ step: 0, completed: false, welcome: false });

export function helpProgressKey(accountId: string, environment: string) {
  return `kordi.help.v1:${encodeURIComponent(environment)}:${encodeURIComponent(accountId)}`;
}

export function readHelpProgress(key: string, storage = resolvePreferenceStorage()): HelpProgress {
  try {
    const value: unknown = JSON.parse(storage ? readPreferenceStorageItem(storage, key) ?? 'null' : 'null');
    if (!value || typeof value !== 'object') return emptyProgress();
    const fields = value as Record<string, unknown>;
    return { step: typeof fields.step === 'number' && Number.isInteger(fields.step) ? Math.max(0, Math.min(4, fields.step)) : 0,
      completed: fields.completed === true, welcome: fields.welcome === true };
  } catch { return emptyProgress(); }
}

export function saveHelpProgress(key: string, progress: HelpProgress, storage = resolvePreferenceStorage()) {
  return storage ? writePreferenceStorageItem(storage, key, JSON.stringify(progress)) : false;
}

export function markHelpWelcome(accountId: string, environment: string) {
  const key = helpProgressKey(accountId, environment);
  saveHelpProgress(key, { ...readHelpProgress(key), welcome: true });
}

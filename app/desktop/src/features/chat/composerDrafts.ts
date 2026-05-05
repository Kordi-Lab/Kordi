import type { ComposerScope } from '@/kordi-app/types';

export type ComposerDraftEntry = { text: string; updatedAt: number };
export type ComposerDraftState = {
  chat:    Record<string, ComposerDraftEntry>;
  project: Record<string, ComposerDraftEntry>;
};

export const EMPTY_COMPOSER_DRAFT_STATE: ComposerDraftState = { chat: {}, project: {} };

export function updateScopeDraft(
  state: ComposerDraftState,
  scope: ComposerScope,
  sessionId: string,
  value: string,
  now: number = Date.now(),
): ComposerDraftState {
  if (!sessionId) return state;
  const scopeMap = state[scope];
  if (value === '') {
    if (!(sessionId in scopeMap)) return state;
    const nextScope = { ...scopeMap };
    delete nextScope[sessionId];
    return { ...state, [scope]: nextScope };
  }
  const existing = scopeMap[sessionId];
  if (existing && existing.text === value) return state;
  return {
    ...state,
    [scope]: {
      ...scopeMap,
      [sessionId]: { text: value, updatedAt: now },
    },
  };
}

function entryFromRecord(value: unknown): ComposerDraftEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = record.text;
  const updatedAt = record.updatedAt;
  if (typeof text !== 'string' || text.length === 0) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  return { text, updatedAt };
}

function scopeFromRecord(value: unknown): Record<string, ComposerDraftEntry> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, ComposerDraftEntry> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = entryFromRecord(raw);
    if (entry) out[key] = entry;
  }
  return out;
}

export function parseStoredComposerDrafts(raw: string | null | undefined): ComposerDraftState {
  if (!raw) return { chat: {}, project: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { chat: {}, project: {} };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { chat: {}, project: {} };
  const record = value as Record<string, unknown>;
  return {
    chat:    scopeFromRecord(record.chat),
    project: scopeFromRecord(record.project),
  };
}

export function serializeStoredComposerDrafts(state: ComposerDraftState): string {
  return JSON.stringify(state);
}

export const COMPOSER_DRAFTS_STORAGE_KEY = 'kordi.composerDrafts.v1';
export const COMPOSER_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const COMPOSER_DRAFT_SCOPE_CAP = 200;

type ComposerDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): ComposerDraftStorage | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage;
}

function pruneScope(scope: Record<string, ComposerDraftEntry>, now: number): Record<string, ComposerDraftEntry> {
  const cutoff = now - COMPOSER_DRAFT_TTL_MS;
  const fresh = Object.entries(scope).filter(([, entry]) => entry.updatedAt >= cutoff);
  if (fresh.length <= COMPOSER_DRAFT_SCOPE_CAP) {
    return Object.fromEntries(fresh);
  }
  fresh.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(fresh.slice(0, COMPOSER_DRAFT_SCOPE_CAP));
}

export function readStoredComposerDrafts(
  storage: ComposerDraftStorage | null = browserStorage(),
  now: number = Date.now(),
): ComposerDraftState {
  if (!storage) return { chat: {}, project: {} };
  const parsed = parseStoredComposerDrafts(storage.getItem(COMPOSER_DRAFTS_STORAGE_KEY));
  return {
    chat:    pruneScope(parsed.chat, now),
    project: pruneScope(parsed.project, now),
  };
}

export function writeStoredComposerDrafts(
  state: ComposerDraftState,
  storage: ComposerDraftStorage | null = browserStorage(),
) {
  if (!storage) return;
  const isEmpty = Object.keys(state.chat).length === 0 && Object.keys(state.project).length === 0;
  if (isEmpty) {
    storage.removeItem(COMPOSER_DRAFTS_STORAGE_KEY);
    return;
  }
  storage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, serializeStoredComposerDrafts(state));
}

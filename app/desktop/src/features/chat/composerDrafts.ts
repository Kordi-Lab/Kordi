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

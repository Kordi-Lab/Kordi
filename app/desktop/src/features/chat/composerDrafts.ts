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

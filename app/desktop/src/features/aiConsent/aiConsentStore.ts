import { useSyncExternalStore } from 'react';

import type { AiConsentClient, AiConsentStatus } from './aiConsentClient';
import { onAiConsentRequired } from './aiConsentSignal';

// The signed-in account's AI consent, shared by the send gates, the prompts and
// Settings › Privacy. The server stores it per account, so every device agrees.

export type AiConsentPrompt = 'consent' | 'off' | null;

export type AiConsentState = {
  accountId: string | null;
  /** null while unknown, or on a server without AI consent; AI actions then go ahead. */
  status: AiConsentStatus | null;
  prompt: AiConsentPrompt;
  saving: boolean;
  error: string | null;
};

const INITIAL_STATE: AiConsentState = { accountId: null, status: null, prompt: null, saving: false, error: null };

/** A server refusal opens the prompt only this soon after a click or key press. */
export const AI_CONSENT_USER_ACTION_WINDOW_MS = 10_000;

export const AI_CONSENT_SAVE_ERROR = "Couldn't save. Try again.";

/** Publish feedback when a save would turn agent work on without consent; the prompt says the rest. */
export const AI_MODELS_OFF_PUBLISH_ERROR = 'AI models are off.';

let state = INITIAL_STATE;
let lastUserInputAt = Number.NEGATIVE_INFINITY;
const listeners = new Set<() => void>();

function update(patch: Partial<AiConsentState>) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

export function getAiConsentState(): AiConsentState {
  return state;
}

export function subscribeAiConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAiConsentState(): AiConsentState {
  return useSyncExternalStore(subscribeAiConsent, getAiConsentState, getAiConsentState);
}

/** Records what the server says for this account; a decision closes a prompt it answers. */
export function applyAiConsent(accountId: string, status: AiConsentStatus | null) {
  if (state.accountId !== accountId) {
    update({ ...INITIAL_STATE, accountId, status });
    return;
  }
  const answered = (state.prompt === 'consent' && (status === 'allowed' || status === 'declined'))
    || (state.prompt === 'off' && status === 'allowed');
  update({ status, ...(answered ? { prompt: null, error: null } : {}) });
}

export function resetAiConsent() {
  update(INITIAL_STATE);
}

/**
 * True when an AI action may go ahead. Otherwise it opens the consent prompt
 * (no decision yet) or "AI models are off" (declined) and returns false.
 */
export function requireAiConsent(): boolean {
  if (state.status === 'declined') {
    update({ prompt: 'off', error: null });
    return false;
  }
  if (state.status === 'unset') {
    update({ prompt: 'consent', error: null });
    return false;
  }
  return true;
}

export function openAiConsentPrompt() {
  if (state.accountId && state.status === 'unset' && state.prompt === null) update({ prompt: 'consent', error: null });
}

export function dismissAiConsentPrompt() {
  if (!state.saving) update({ prompt: null, error: null });
}

export async function saveAiConsent(
  choice: Exclude<AiConsentStatus, 'unset'>,
  client: AiConsentClient,
): Promise<boolean> {
  const accountId = state.accountId;
  if (!accountId || state.saving) return false;
  update({ saving: true, error: null });
  try {
    const saved = await client.put(choice);
    if (state.accountId !== accountId) return false;
    update({ status: saved.status, saving: false, prompt: null, error: null });
    return true;
  } catch {
    if (state.accountId === accountId) update({ saving: false, error: AI_CONSENT_SAVE_ERROR });
    return false;
  }
}

export function noteAiConsentUserInput(at = Date.now()) {
  lastUserInputAt = at;
}

/**
 * A server answered `ai_consent_required`: the account declined, perhaps on
 * another device. The prompt opens only right after the person acted, so
 * background work never pops it.
 */
export function handleAiConsentRequired(now = Date.now()) {
  if (!state.accountId) return;
  const fromPerson = now - lastUserInputAt <= AI_CONSENT_USER_ACTION_WINDOW_MS;
  update({ status: 'declined', ...(fromPerson && state.prompt === null ? { prompt: 'off' as const, error: null } : {}) });
}

onAiConsentRequired(() => handleAiConsentRequired());

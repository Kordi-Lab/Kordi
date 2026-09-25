import type { AuthDisplayProvider } from './model';

// Custom API accounts reach an OpenAI-compatible endpoint that OMP does not
// catalog, so the account itself carries the model the endpoint serves. The
// server records the published `model` as the account's model hint.

export const CUSTOM_PROVIDER_ID = 'custom';
export const CUSTOM_MODEL_MAX_LENGTH = 120;
/** Shown on a Custom API account saved without a model, and on Start chat while it blocks. */
export const CUSTOM_MODEL_REQUIRED = 'Add a model ID to start chatting';

/** Why a model ID cannot be saved, or null when it can. */
export function customModelIdError(value: string): string | null {
  const model = value.trim();
  if (!model) return 'Enter the model ID your endpoint serves.';
  if (model.length > CUSTOM_MODEL_MAX_LENGTH) return `Use at most ${CUSTOM_MODEL_MAX_LENGTH} characters.`;
  if (/\s/.test(model) || [...model].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return 'Model IDs cannot contain spaces.';
  }
  return null;
}

/** A saved Custom API account as the edit form needs it; its key and base URL stay on the server. */
export type CustomApiAccount = { authChoice: string; label: string; model: string | null };

export function customApiAccounts(provider: AuthDisplayProvider): CustomApiAccount[] {
  if (provider.id !== CUSTOM_PROVIDER_ID) return [];
  return provider.methods.flatMap((method) => method.options)
    .filter((option) => option.profileId)
    .map((option) => ({ authChoice: option.value, label: option.label, model: option.modelHint?.trim() || null }));
}

/** "Custom API · deepseek-chat" for the saved account row. */
export function customApiAccountSummary(model: string | null | undefined) {
  return model?.trim() ? `Custom API · ${model.trim()}` : 'Custom API';
}

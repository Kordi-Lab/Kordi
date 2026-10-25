import { ACCOUNT_UNAVAILABLE_LABEL, isAccountAuthChoice } from '@/features/cloud/routeAccountChoice';
import { fallbackComposerThinkingValue } from './composerThinking';

export type ComposerProviderOption = {
  value: string;
  providerId: string;
  label: string;
  detail?: string | null;
  selectionLabel?: string;
  active?: boolean;
  /** Saved in the Kordi account rather than on this device. */
  hosted?: boolean;
  /** The route names an account this device no longer has. */
  unavailable?: boolean;
  /** Listed but not selectable, for example a hosted account that needs reconnecting. */
  disabled?: boolean;
  disabledReason?: string;
};

export type ComposerModelOption = {
  value: string;
  label: string;
  detail?: string | null;
  provider?: string;
  providerLabel?: string;
  thinkingLevels?: string[];
};

export type ComposerModelSelection = {
  model: string;
  authProvider?: string | null;
  authChoice?: string | null;
};

export function normalizeComposerProviderId(providerId: string) {
  const normalized = providerId.trim().toLowerCase();
  return normalized === 'openai-codex' ? 'openai' : normalized;
}

export function authChoiceFromProviderOption(option: ComposerProviderOption) {
  return option.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;
}

/** Resolve one saved account across a legacy provider alias without borrowing another choice. */
export function matchingComposerAccountOption(
  providerId: string | null | undefined,
  authChoice: string | null | undefined,
  providerOptions: readonly ComposerProviderOption[],
): ComposerProviderOption | null {
  if (!providerId) return null;
  const accountOptions = providerOptions.filter((option) => authChoiceFromProviderOption(option) === (authChoice ?? null));
  const exact = accountOptions.find((option) => option.providerId === providerId);
  if (exact) return exact;
  if (!isAccountAuthChoice(authChoice)) return null;
  const family = accountOptions.filter((option) => (
    normalizeComposerProviderId(option.providerId) === normalizeComposerProviderId(providerId)
  ));
  return family.length === 1 ? family[0] : null;
}

export function providerDisplayLabel(providerId: string) {
  switch (providerId) {
    case 'anthropic':
      return 'Claude';
    case 'openai':
    case 'openai-codex':
      return 'OpenAI';
    case 'google':
      return 'Google Gemini';
    case 'github-copilot':
      return 'GitHub Copilot';
    case 'groq':
      return 'Groq';
    case 'lm-studio':
      return 'LM Studio';
    case 'ollama':
      return 'Ollama';
    case 'openrouter':
      return 'OpenRouter';
    case 'xai':
      return 'xAI';
    default:
      return providerId;
  }
}

export function resolveComposerModelSelection({
  selection,
  providerOptions,
  modelOptions,
}: {
  selection: ComposerModelSelection;
  providerOptions: ComposerProviderOption[];
  modelOptions: ComposerModelOption[];
}) {
  const selectedModelOption = modelOptions.find((option) => option.value === selection.model);
  const parsedSelection = selection.model.split('/');
  const fallbackProviderValue = normalizeComposerProviderId(parsedSelection[0] ?? '');
  const fallbackModelLabel = parsedSelection.slice(1).join('/').trim() || selection.model;
  const fallbackProviderKnown = Boolean(fallbackProviderValue) && (
    providerOptions.some(
      (option) => normalizeComposerProviderId(option.providerId) === fallbackProviderValue,
    )
    || modelOptions.some((option) => normalizeComposerProviderId(option.provider ?? '') === fallbackProviderValue)
  );
  // Model options keep their catalog provider id (for example `openai-codex`),
  // so compare them in the same normalized form as the provider options.
  const modelProviderValue = (selectedModelOption?.provider ? normalizeComposerProviderId(selectedModelOption.provider) : '')
    || (fallbackProviderKnown ? fallbackProviderValue : '');
  const selectedProviderValue = modelProviderValue && providerOptions.some(
    (option) => normalizeComposerProviderId(option.providerId) === modelProviderValue,
  )
    ? modelProviderValue
    : '';
  const selectedAuthProviderOption = matchingComposerAccountOption(
    selection.authProvider,
    selection.authChoice,
    providerOptions,
  );
  // A route bound to a removed account stays on it, marked unavailable, until
  // the owner explicitly chooses another account.
  const missingAccountOption: ComposerProviderOption | null = selection.authProvider
    && !selectedAuthProviderOption && isAccountAuthChoice(selection.authChoice)
    ? {
        value: `${selection.authProvider}::${selection.authChoice?.trim()}`,
        providerId: selection.authProvider,
        label: ACCOUNT_UNAVAILABLE_LABEL,
        selectionLabel: ACCOUNT_UNAVAILABLE_LABEL,
        unavailable: true,
      }
    : null;
  const selectedProviderOption = selectedAuthProviderOption
    ?? missingAccountOption
    ?? providerOptions.find(
      (option) => (
        normalizeComposerProviderId(option.providerId) === selectedProviderValue
        && option.active
      ),
    )
    ?? providerOptions.find(
      (option) => normalizeComposerProviderId(option.providerId) === selectedProviderValue,
    )
    ?? null;

  return {
    fallbackModelLabel,
    selectedModelOption,
    selectedProviderOption,
    selectedProviderValue: missingAccountOption ? normalizeComposerProviderId(missingAccountOption.providerId) : selectedProviderValue,
    missingAccount: Boolean(missingAccountOption),
    // A dialog opens on a signed-in account of the same provider in place of a
    // removed one; saving applies it.
    initialProviderValue: (missingAccountOption
      ? sameProviderComposerAccount(missingAccountOption.providerId, providerOptions)?.value
      : null) ?? selectedProviderOption?.value ?? '',
  };
}

/** True when a session route names an account that is not among the provider options. */
export function isRouteAccountUnavailable(
  selection: ComposerModelSelection,
  providerOptions: ComposerProviderOption[],
) {
  return resolveComposerModelSelection({ selection, providerOptions, modelOptions: [] }).missingAccount;
}

/** An account that can run a route now: signed in and not waiting to reconnect. */
export function composerProviderOptionUsable(option: ComposerProviderOption | null | undefined): boolean {
  return Boolean(option && !option.unavailable && !option.disabled);
}

/** The models a provider offers; a model without a provider is offered by every provider. */
export function composerModelsForProvider(providerId: string, modelOptions: readonly ComposerModelOption[]) {
  const normalized = normalizeComposerProviderId(providerId);
  return modelOptions.filter((option) => !option.provider || normalizeComposerProviderId(option.provider) === normalized);
}

/** A usable account of the same provider, the active one first. */
export function sameProviderComposerAccount(
  providerId: string | null | undefined,
  providerOptions: readonly ComposerProviderOption[],
): ComposerProviderOption | null {
  if (!providerId?.trim()) return null;
  const normalized = normalizeComposerProviderId(providerId);
  const candidates = providerOptions.filter((option) => (
    composerProviderOptionUsable(option) && normalizeComposerProviderId(option.providerId) === normalized
  ));
  return candidates.find((option) => option.active) ?? candidates[0] ?? null;
}

/** True when no account can run a route, so the picker offers sign-in instead. */
export function composerSignInRequired(providerOptions: readonly ComposerProviderOption[]) {
  return !providerOptions.some((option) => composerProviderOptionUsable(option));
}

/**
 * The route that replaces a stored account this device no longer has: a
 * usable account of the same provider, else the only usable account, with a
 * model and thinking level it offers. Null when the account is not missing or
 * the choice is not clear; then the owner chooses.
 */
export function unavailableAccountReplacement({
  selection,
  providerOptions,
  modelOptions,
}: {
  selection: ComposerModelSelection & { thinking: string };
  providerOptions: ComposerProviderOption[];
  modelOptions: ComposerModelOption[];
}): ComposerRoute | null {
  const resolved = resolveComposerModelSelection({ selection, providerOptions, modelOptions });
  if (!resolved.missingAccount || !resolved.selectedProviderOption) return null;
  const usable = providerOptions.filter((option) => composerProviderOptionUsable(option));
  const option = sameProviderComposerAccount(resolved.selectedProviderOption.providerId, providerOptions)
    ?? (usable.length === 1 ? usable[0] : null);
  return option ? resolveComposerRoutePick({ selection, providerOptions, modelOptions, pick: { type: 'provider', option } }) : null;
}

export type ComposerRoute = {
  providerOption: ComposerProviderOption | null;
  model: string;
  thinking: string;
};

export type ComposerRoutePick =
  | { type: 'provider'; option: ComposerProviderOption }
  | { type: 'model'; value: string }
  | { type: 'thinking'; value: string };

function modelIdOf(value: string) {
  const separator = value.indexOf('/');
  return separator > 0 ? value.slice(separator + 1) : value;
}

/**
 * The complete route one pick applies, so no control is left without a valid
 * value. An account that is gone or switched off gives way to a signed-in
 * account of the same provider, a model the account does not offer gives way
 * to its default model, and the thinking level follows the model. Null when no
 * account can run the pick.
 */
export function resolveComposerRoutePick({
  selection,
  providerOptions,
  modelOptions,
  pick,
}: {
  selection: ComposerModelSelection & { thinking: string };
  providerOptions: ComposerProviderOption[];
  modelOptions: ComposerModelOption[];
  pick: ComposerRoutePick;
}): ComposerRoute | null {
  const resolved = resolveComposerModelSelection({ selection, providerOptions, modelOptions });
  const current = resolved.selectedProviderOption;
  const currentProviderId = current?.providerId ?? resolved.selectedProviderValue;
  const requestedModel = pick.type === 'model' ? pick.value : selection.model;
  const requestedModelOption = modelOptions.find((option) => option.value === requestedModel);

  let account: ComposerProviderOption | null;
  if (pick.type === 'provider') {
    account = composerProviderOptionUsable(pick.option)
      ? pick.option
      : sameProviderComposerAccount(pick.option.providerId, providerOptions);
  } else if (pick.type === 'model') {
    const modelProviderId = requestedModelOption?.provider ?? (requestedModel.includes('/') ? requestedModel.split('/')[0] : '');
    const sameProvider = !modelProviderId || (Boolean(currentProviderId)
      && normalizeComposerProviderId(modelProviderId) === normalizeComposerProviderId(currentProviderId));
    account = sameProvider && current && composerProviderOptionUsable(current)
      ? current
      : sameProviderComposerAccount(modelProviderId || currentProviderId, providerOptions);
  } else {
    account = current && composerProviderOptionUsable(current) ? current : sameProviderComposerAccount(currentProviderId, providerOptions);
  }
  if (!account) return null;

  const offered = composerModelsForProvider(account.providerId, modelOptions);
  const offeredModel = offered.length === 0 || offered.some((option) => option.value === requestedModel)
    ? requestedModel
    : (offered.find((option) => modelIdOf(option.value) === modelIdOf(requestedModel)) ?? offered[0]).value;
  // An account runs only models in its own provider namespace.
  const accountModel = `${account.providerId}/${modelIdOf(offeredModel)}`;
  const model = offeredModel.includes('/') && !offeredModel.startsWith(`${account.providerId}/`)
    && modelOptions.some((option) => option.value === accountModel)
    ? accountModel
    : offeredModel;
  const modelOption = modelOptions.find((option) => option.value === model);
  const thinking = pick.type === 'thinking'
    ? pick.value
    : fallbackComposerThinkingValue(modelOption?.thinkingLevels ?? [], selection.thinking);
  return { providerOption: account, model, thinking };
}

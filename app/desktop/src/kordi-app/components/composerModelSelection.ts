export type ComposerProviderOption = {
  value: string;
  providerId: string;
  label: string;
  detail?: string | null;
  selectionLabel?: string;
  active?: boolean;
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

function authChoiceFromProviderOption(option: ComposerProviderOption) {
  return option.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;
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
    || modelOptions.some((option) => option.provider === fallbackProviderValue)
  );
  const modelProviderValue = selectedModelOption?.provider
    ?? (fallbackProviderKnown ? fallbackProviderValue : '');
  const selectedProviderValue = modelProviderValue && providerOptions.some(
    (option) => normalizeComposerProviderId(option.providerId) === modelProviderValue,
  )
    ? modelProviderValue
    : '';
  const selectedAuthProviderOption = selection.authProvider
    ? providerOptions.find((option) => (
        option.providerId === selection.authProvider
        && authChoiceFromProviderOption(option) === (selection.authChoice ?? null)
      )) ?? null
    : null;
  const selectedProviderOption = selectedAuthProviderOption
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
    selectedProviderValue,
  };
}

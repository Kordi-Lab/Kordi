import { useCallback, useMemo } from 'react';

import { buildAuthDisplayProviders, isLocalProvider, normalizeSelectedProviderId } from '@/kordi-app/auth/model';
import type { ComposerAuthOption, ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import type {
  ComposerScope,
  DesktopAuthState,
  DesktopChatSlashCommand,
  DesktopChatState,
} from '@/kordi-app/types';

type ComposerSelections = Record<ComposerScope, { mode: string; model: string; thinking: string }>;
type ComposerDrafts = Record<ComposerScope, string>;

type UseComposerViewModelArgs = {
  isNativeShell: boolean;
  desktopAuthState: DesktopAuthState | null;
  desktopChatState: DesktopChatState | null;
  composerSelections: ComposerSelections;
  composerDrafts: ComposerDrafts;
};

export function useComposerViewModel({
  isNativeShell,
  desktopAuthState,
  desktopChatState,
  composerSelections,
  composerDrafts,
}: UseComposerViewModelArgs) {
  const authDisplayProviders = useMemo(() => buildAuthDisplayProviders(desktopAuthState), [desktopAuthState]);

  const chatModelOptions = useMemo<ComposerModelOption[]>(() => {
    if (!isNativeShell) {
      return [];
    }

    const options = (desktopChatState?.modelOptions ?? []).map((option) => ({
      value: option.value,
      label: option.label,
      detail: option.detail,
      provider: option.provider,
      providerLabel: option.providerLabel,
    }));

    for (const provider of authDisplayProviders) {
      const providerId = normalizeSelectedProviderId(provider.id) ?? provider.id;
      const preferredModel = provider.preferredModel?.trim();
      if (!provider.configured || !isLocalProvider(providerId) || !preferredModel) continue;
      const [modelProvider, ...modelParts] = preferredModel.split('/');
      const normalizedModelProvider = normalizeSelectedProviderId(modelProvider) ?? modelProvider;
      const modelId = normalizedModelProvider === providerId && modelParts.length > 0 ? modelParts.join('/') : preferredModel;
      const value = `${providerId}/${modelId}`;
      if (options.some((option) => option.value === value)) continue;
      options.push({
        value,
        label: modelId,
        detail: `${provider.label} • saved local model`,
        provider: providerId,
        providerLabel: provider.label,
      });
    }

    for (const selection of [composerSelections.chat.model, composerSelections.project.model]) {
      const [provider, ...modelParts] = selection.split('/');
      const modelId = modelParts.join('/').trim();
      if (!['lm-studio', 'ollama'].includes(provider) || !modelId || options.some((option) => option.value === selection)) continue;
      options.push({
        value: selection,
        label: modelId,
        detail: `${provider === 'lm-studio' ? 'LM Studio' : 'Ollama'} • selected local model`,
        provider,
        providerLabel: provider === 'lm-studio' ? 'LM Studio' : 'Ollama',
      });
    }

    return options;
  }, [authDisplayProviders, composerSelections.chat.model, composerSelections.project.model, desktopChatState?.modelOptions, isNativeShell]);

  const composerProviderOptions = useMemo<ComposerProviderOption[]>(() => {
    const displayProviders = authDisplayProviders;
    const providerLabels = new Map(chatModelOptions.map((option) => [option.provider ?? '', option.providerLabel ?? option.provider ?? '']));
    const profileSuffix = (profileId?: string | null) => profileId?.slice(-6) ?? null;
    const accountSuffix = (accountLabel?: string | null) => {
      const compact = accountLabel?.trim();
      if (!compact) return null;
      return compact.replace(/-/g, '').slice(-6) || null;
    };
    const detailIdentity = (detail?: string | null) => {
      const first = detail?.split(' • ').find((part) => part && part !== 'kordi auth.json' && part !== 'environment');
      return first?.trim() || null;
    };

    return displayProviders
      .flatMap<ComposerProviderOption>((provider) => {
        let oauthIndex = 0;
        let apiIndex = 0;
        const providerOptions: ComposerProviderOption[] = provider.methods.flatMap((method) =>
          method.options.map((option) => {
            const index = method.mode === 'oauth' ? ++oauthIndex : ++apiIndex;
            const oauthId = accountSuffix(option.accountLabel) ?? profileSuffix(option.profileId) ?? `${index}`;
            const oauthExtra = detailIdentity(option.detail);
            const identity = method.mode === 'oauth'
              ? [`oauth id ${oauthId}`, oauthExtra].filter(Boolean).join(' • ')
              : (option.profileId ? `api id ${profileSuffix(option.profileId)}` : detailIdentity(option.detail)) ?? `api id ${index}`;

            return {
              value: `${provider.id}::${option.value}`,
              providerId: provider.id,
              label: method.title,
              detail: identity,
              selectionLabel: `${method.title} • ${method.mode === 'oauth' ? `oauth id ${oauthId}` : identity}`.trim(),
              active: option.active,
            };
          }),
        );

        if (providerOptions.length > 0) {
          return providerOptions;
        }

        return [{
          value: provider.id,
          providerId: provider.id,
          label: provider.label,
          detail: provider.preferredModel ? `Saved model ${provider.preferredModel}` : provider.localBaseUrl ? `Endpoint ${provider.localBaseUrl}` : null,
          selectionLabel: provider.label,
          active: false,
        }];
      })
      .filter((option) => {
        const modelProviderId = normalizeSelectedProviderId(option.providerId) ?? option.providerId;
        const displayProvider = displayProviders.find((provider) => provider.id === modelProviderId);
        return providerLabels.has(modelProviderId)
          || chatModelOptions.some((model) => model.provider === modelProviderId)
          || (displayProvider?.configured && ['lm-studio', 'ollama'].includes(modelProviderId));
      });
  }, [authDisplayProviders, chatModelOptions]);

  const preferredModelValueForProvider = useCallback((providerId: string) => {
    const modelProviderId = normalizeSelectedProviderId(providerId) ?? providerId;
    const providerModels = chatModelOptions.filter((option) => option.provider === modelProviderId);
    const savedLocalProvider = authDisplayProviders.find((provider) => (normalizeSelectedProviderId(provider.id) ?? provider.id) === modelProviderId);
    const savedLocalModel = savedLocalProvider?.preferredModel?.trim();
    const savedLocalModelValue = savedLocalProvider?.configured && isLocalProvider(modelProviderId) && savedLocalModel
      ? (() => {
          const [savedProvider, ...modelParts] = savedLocalModel.split('/');
          const normalizedSavedProvider = normalizeSelectedProviderId(savedProvider) ?? savedProvider;
          const modelId = normalizedSavedProvider === modelProviderId && modelParts.length > 0 ? modelParts.join('/') : savedLocalModel;
          return `${modelProviderId}/${modelId}`;
        })()
      : null;

    if (savedLocalModelValue && providerModels.some((option) => option.value === savedLocalModelValue)) {
      return savedLocalModelValue;
    }
    if (providerModels.length === 0) return savedLocalModelValue;

    const preferOpenAiSubscriptionModels = providerId === 'openai-codex';
    const preferredNeedles = modelProviderId === 'anthropic'
      ? ['claude-opus-4-7', 'claude-opus-4.7', 'claude-opus-4-6', 'claude-opus']
      : modelProviderId === 'openai'
        ? (preferOpenAiSubscriptionModels
            ? ['gpt-5.5', 'gpt-5-5', 'gpt-5.4', 'gpt-5']
            : ['gpt-5.4', 'gpt-5-4', 'gpt-5'])
        : [];

    for (const needle of preferredNeedles) {
      const match = providerModels.find((option) => option.label.toLowerCase().includes(needle));
      if (match) return match.value;
    }

    return savedLocalModelValue ?? providerModels[0]?.value ?? null;
  }, [authDisplayProviders, chatModelOptions]);

  const resolveComposerProviderId = useCallback((_: ComposerScope, modelLabel: string) => {
    const option = chatModelOptions.find((candidate) => candidate.value === modelLabel);
    if (option?.provider) return option.provider;

    const availableProviders = new Set(chatModelOptions.map((candidate) => candidate.provider).filter(Boolean));
    const explicitProvider = modelLabel.split('/')[0]?.trim();
    if (explicitProvider && availableProviders.has(explicitProvider)) {
      return explicitProvider;
    }

    const normalized = modelLabel.toLowerCase();
    if (availableProviders.has('anthropic') && normalized.includes('claude')) return 'anthropic';
    if (availableProviders.has('google') && normalized.includes('gemini')) return 'google';
    if (availableProviders.has('groq') && normalized.includes('groq')) return 'groq';
    if (availableProviders.has('lm-studio') && (normalized.includes('lm-studio') || normalized.includes('lm studio'))) return 'lm-studio';
    if (availableProviders.has('ollama') && normalized.includes('ollama')) return 'ollama';
    if (availableProviders.has('openrouter') && normalized.includes('openrouter')) return 'openrouter';
    if (availableProviders.has('xai') && (normalized.includes('xai') || normalized.includes('grok'))) return 'xai';
    if (availableProviders.has('github-copilot') && normalized.includes('copilot')) return 'github-copilot';
    return availableProviders.has('openai') ? 'openai' : Array.from(availableProviders)[0] ?? 'openai';
  }, [chatModelOptions]);

  const composerAuthByScope = useMemo(() => {
    const displayProviders = buildAuthDisplayProviders(desktopAuthState);
    const optionsByScope = {} as Record<ComposerScope, ComposerAuthOption[]>;
    const labelByScope = {} as Record<ComposerScope, string>;

    (['chat', 'project'] as const).forEach((scope) => {
      const providerId = resolveComposerProviderId(scope, composerSelections[scope].model);
      const displayProvider = displayProviders.find((item) => item.id === providerId) ?? null;
      const orderedProviders = [...displayProviders].sort((left, right) => {
        const leftIsCurrent = left.id === providerId;
        const rightIsCurrent = right.id === providerId;
        return Number(rightIsCurrent) - Number(leftIsCurrent);
      });
      const options: ComposerAuthOption[] = orderedProviders.flatMap((provider) =>
        provider.methods.flatMap((method) =>
          method.options.map((option) => ({
            providerId: option.providerId,
            providerLabel: provider.label,
            methodLabel: method.mode === 'oauth' ? 'OAuth' : 'API key',
            value: option.value,
            label: option.label,
            detail: option.detail,
            active: option.active,
          })),
        ),
      );
      const active = (displayProvider?.methods ?? [])
        .flatMap((method) => method.options)
        .find((option) => option.active) ?? null;
      const activeProviderLabel = displayProvider?.label;
      optionsByScope[scope] = options;
      labelByScope[scope] = active
        ? [activeProviderLabel, active.label].filter(Boolean).join(' · ')
        : (options.length > 0 ? 'Select auth' : 'No auth');
    });

    return {
      optionsByScope,
      labelByScope,
    };
  }, [composerSelections, desktopAuthState, resolveComposerProviderId]);

  const chatSlashQuery = useMemo(() => {
    const text = composerDrafts.chat.trim();
    if (!text.startsWith('/')) return null;
    if (/\s/.test(text)) return null;
    return text;
  }, [composerDrafts.chat]);

  const projectSlashQuery = useMemo(() => {
    const text = composerDrafts.project.trim();
    if (!text.startsWith('/')) return null;
    if (/\s/.test(text)) return null;
    return text;
  }, [composerDrafts.project]);

  const filterSlashCommands = useCallback((query: string | null) => {
    if (!isNativeShell || !desktopChatState?.slashCommands?.length || !query) {
      return [] as DesktopChatSlashCommand[];
    }

    const normalizedQuery = query.toLowerCase();
    const search = normalizedQuery.slice(1);

    return desktopChatState.slashCommands.filter((item) => {
      if (!search) return true;
      const value = item.value.toLowerCase();
      const label = item.label.toLowerCase();
      const detail = item.detail?.toLowerCase() ?? '';
      return value.startsWith(normalizedQuery)
        || label.startsWith(normalizedQuery)
        || value.includes(search)
        || label.includes(search)
        || detail.includes(search);
    });
  }, [desktopChatState?.slashCommands, isNativeShell]);

  const filteredChatSlashCommands = useMemo(() => filterSlashCommands(chatSlashQuery), [chatSlashQuery, filterSlashCommands]);
  const filteredProjectSlashCommands = useMemo(() => filterSlashCommands(projectSlashQuery), [filterSlashCommands, projectSlashQuery]);

  return {
    chatModelOptions,
    composerProviderOptions,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    composerAuthByScope,
    chatSlashQuery,
    projectSlashQuery,
    filteredChatSlashCommands,
    filteredProjectSlashCommands,
  };
}

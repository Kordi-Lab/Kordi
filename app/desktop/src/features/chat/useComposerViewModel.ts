import { useCallback, useEffect, useMemo } from 'react';

import {
  buildAuthDisplayProviders,
  isLocalProvider,
  normalizeSelectedProviderId,
  type AuthDisplayProvider,
} from '@/kordi-app/auth/model';
import type { ComposerAuthOption, ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import { useHostedAccounts } from '@/features/cloud/hostedAccounts';
import { setLocalAccountChoices, setLocalProviderIds } from '@/features/cloud/hostedAccountRegistry';
import { routeRunsOnKordiCloud } from '@/features/cloud/cloudAgentRuntimeRoute';
import { useActiveChatRoute } from './kordiCloudChatRoute';
import {
  CUSTOM_ROUTE_PROVIDER,
  hostedAuthOptions,
  hostedModelOptions,
  hostedProviderOptions,
  hostedRouteAccounts,
  isCustomRouteModel,
} from './hostedComposerOptions';
import type {
  ComposerScope,
  DesktopAuthState,
  DesktopChatSlashCommand,
  DesktopChatState,
} from '@/kordi-app/types';

type ComposerSelections = Record<ComposerScope, { mode: string; model: string; thinking: string }>;
type ComposerDrafts = Record<ComposerScope, string>;

function localModelMatchesAny(modelId: string, needles: string[]) {
  const normalizedModel = modelId.trim().toLowerCase().replace(/[\s_]/g, '-');
  return needles.some((needle) => normalizedModel.includes(needle));
}

function inferLocalThinkingLevels(providerId: string, modelId: string) {
  const normalizedProvider = normalizeSelectedProviderId(providerId) ?? providerId;
  if (normalizedProvider === 'ollama' && localModelMatchesAny(modelId, ['gpt-oss', 'gptoss'])) {
    return ['low', 'medium', 'high'];
  }
  if (
    localModelMatchesAny(modelId, [
      'thinking',
      'reasoning',
      'reasoner',
      'qwen3',
      'qwen-3',
      'qwq',
      'deepseek-r1',
      'deepseek-v3.1',
      'deepseek-v3-1',
      'deepseek-v31',
      'gemma-3n',
      'gemma3n',
      'gemma-4',
      'gemma4',
      'magistral',
      'phi-4-reasoning',
      'phi4-reasoning',
      'seed-oss',
      'seedoss',
      'glm-z1',
      'glmz1',
    ])
    || (normalizedProvider === 'lm-studio' && localModelMatchesAny(modelId, ['gpt-oss', 'gptoss']))
  ) {
    return ['default'];
  }
  return ['off'];
}

type UseComposerViewModelArgs = {
  isNativeShell: boolean;
  desktopAuthState: DesktopAuthState | null;
  desktopChatState: DesktopChatState | null;
  composerSelections: ComposerSelections;
  composerDrafts: ComposerDrafts;
};

type PreferredRuntimeRoute = {
  provider: string;
  model: string;
};

export function preferredModelValueForProviderFromOptions(
  providerId: string,
  chatModelOptions: ComposerModelOption[],
  authDisplayProviders: AuthDisplayProvider[],
  preferredRuntimeRoute?: PreferredRuntimeRoute | null,
) {
  const modelProviderId = normalizeSelectedProviderId(providerId) ?? providerId;
  const providerModels = chatModelOptions.filter((option) => option.provider === modelProviderId);
  const savedLocalProvider = authDisplayProviders.find((provider) => (normalizeSelectedProviderId(provider.id) ?? provider.id) === modelProviderId);
  const savedLocalModel = savedLocalProvider?.preferredModel?.trim();
  const savedLocalModelValue = savedLocalProvider?.configured && isLocalProvider(modelProviderId) && modelProviderId !== 'ollama' && savedLocalModel
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

  const preferredRouteProvider = preferredRuntimeRoute
    ? normalizeSelectedProviderId(preferredRuntimeRoute.provider) ?? preferredRuntimeRoute.provider
    : null;
  const preferredRuntimeModel = preferredRouteProvider === modelProviderId
    ? preferredRuntimeRoute?.model.trim().toLowerCase()
    : null;
  if (preferredRuntimeModel) {
    const normalizedPreferredModel = preferredRuntimeModel.startsWith(`${modelProviderId}/`)
      ? preferredRuntimeModel.slice(modelProviderId.length + 1)
      : preferredRuntimeModel;
    const exactRuntimeMatch = providerModels.find((option) => {
      const normalizedValue = option.value.trim().toLowerCase();
      const normalizedValueModel = normalizedValue.startsWith(`${modelProviderId}/`)
        ? normalizedValue.slice(modelProviderId.length + 1)
        : normalizedValue;
      return normalizedValueModel === normalizedPreferredModel
        || option.label.trim().toLowerCase() === normalizedPreferredModel;
    });
    if (exactRuntimeMatch) return exactRuntimeMatch.value;
  }
  const preferredNeedles = modelProviderId === 'anthropic'
    ? ['claude-opus-4-7', 'claude-opus-4.7', 'claude-opus-4-6', 'claude-opus']
    : modelProviderId === 'openai'
      ? ['gpt-5.6-sol', 'gpt-5-6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5']
      : [];

  for (const needle of preferredNeedles) {
    const match = providerModels.find((option) => option.label.toLowerCase().includes(needle));
    if (match) return match.value;
  }

  return savedLocalModelValue ?? providerModels[0]?.value ?? null;
}

export function useComposerViewModel({
  isNativeShell,
  desktopAuthState,
  desktopChatState,
  composerSelections,
  composerDrafts,
}: UseComposerViewModelArgs) {
  const authDisplayProviders = useMemo(() => buildAuthDisplayProviders(desktopAuthState), [desktopAuthState]);
  // Hosted accounts run on Kordi Cloud; accounts on this Mac run here.
  const hostedState = useHostedAccounts(isNativeShell);
  // Null until this Mac's accounts load (and again while they reload), so no copy of them runs on Kordi Cloud.
  const localChoiceKey = desktopAuthState
    ? JSON.stringify(desktopAuthState.providers.flatMap((provider) => provider.options.map((option) => option.value)))
    : null;
  const localProviderKey = JSON.stringify((desktopAuthState?.providers ?? []).filter((provider) => provider.configured).map((provider) => provider.id));
  useEffect(() => {
    setLocalAccountChoices(localChoiceKey === null ? null : JSON.parse(localChoiceKey) as string[]);
    setLocalProviderIds(JSON.parse(localProviderKey) as string[]);
  }, [localChoiceKey, localProviderKey]);
  const hostedAccounts = useMemo(
    () => hostedRouteAccounts(hostedState.accounts, hostedState.catalog, localChoiceKey === null ? null : new Set(JSON.parse(localChoiceKey) as string[])),
    [hostedState, localChoiceKey],
  );
  // The session's hosted account, or for a custom model the account that serves it.
  const activeChatRoute = useActiveChatRoute();
  const activeHostedChoice = routeRunsOnKordiCloud(activeChatRoute)
    ? activeChatRoute?.authChoice ?? null
    : hostedAccounts.find((account) => isCustomRouteModel(composerSelections.chat.model)
      && `${account.providerId}/${account.model}` === composerSelections.chat.model.trim())?.authChoice ?? null;

  const chatModelOptions = useMemo<ComposerModelOption[]>(() => {
    if (!isNativeShell) {
      return [];
    }

    const options: ComposerModelOption[] = (desktopChatState?.modelOptions ?? []).map((option) => ({
      value: option.value,
      label: option.label,
      detail: option.detail,
      provider: option.provider,
      providerLabel: option.providerLabel,
      thinkingLevels: option.thinkingLevels,
    }));

    for (const provider of authDisplayProviders) {
      const providerId = normalizeSelectedProviderId(provider.id) ?? provider.id;
      const preferredModel = provider.preferredModel?.trim();
      if (!provider.configured || !isLocalProvider(providerId) || !preferredModel || providerId === 'ollama') continue;
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
        thinkingLevels: inferLocalThinkingLevels(providerId, modelId),
      });
    }

    for (const selection of [composerSelections.chat.model, composerSelections.project.model]) {
      const [provider, ...modelParts] = selection.split('/');
      const modelId = modelParts.join('/').trim();
      if (provider !== 'lm-studio' || !modelId || options.some((option) => option.value === selection)) continue;
      options.push({
        value: selection,
        label: modelId,
        detail: `${provider === 'lm-studio' ? 'LM Studio' : 'Ollama'} • selected local model`,
        provider,
        providerLabel: provider === 'lm-studio' ? 'LM Studio' : 'Ollama',
        thinkingLevels: inferLocalThinkingLevels(provider, modelId),
      });
    }

    for (const option of hostedModelOptions(hostedAccounts)) {
      if (!options.some((existing) => existing.value === option.value)) options.push(option);
    }

    return options;
  }, [authDisplayProviders, composerSelections.chat.model, composerSelections.project.model, desktopChatState?.modelOptions, hostedAccounts, isNativeShell]);

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
      .filter((provider) => provider.configured)
      .flatMap<ComposerProviderOption>((provider) => {
        if (provider.id === CUSTOM_ROUTE_PROVIDER) return [];
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
              value: `${option.providerId}::${option.value}`,
              providerId: option.providerId,
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
          || (displayProvider?.configured && modelProviderId === 'lm-studio');
      })
      .concat(hostedProviderOptions(hostedAccounts, activeHostedChoice));
  }, [activeHostedChoice, authDisplayProviders, chatModelOptions, hostedAccounts]);

  const preferredModelValueForProvider = useCallback((providerId: string) => (
    preferredModelValueForProviderFromOptions(
      providerId,
      chatModelOptions,
      authDisplayProviders,
      desktopChatState?.localAgent
        ? {
            provider: desktopChatState.localAgent.defaultProvider,
            model: desktopChatState.localAgent.defaultModel,
          }
        : null,
    )
  ), [authDisplayProviders, chatModelOptions, desktopChatState?.localAgent]);

  const resolveComposerProviderId = useCallback((_: ComposerScope, modelLabel: string) => {
    const option = chatModelOptions.find((candidate) => candidate.value === modelLabel);
    if (option?.provider) return option.provider;
    // A Custom API route names its own endpoint's model; it never resolves to another provider.
    if (isCustomRouteModel(modelLabel)) return CUSTOM_ROUTE_PROVIDER;

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
      const options: ComposerAuthOption[] = orderedProviders.filter((provider) => provider.id !== CUSTOM_ROUTE_PROVIDER).flatMap((provider) =>
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
      const hostedOptions = hostedAuthOptions(hostedAccounts, scope === 'chat' ? activeHostedChoice : null);
      const hostedActive = hostedOptions.find((option) => option.active) ?? null;
      const active = hostedActive
        ?? (displayProvider?.methods ?? []).flatMap((method) => method.options).find((option) => option.active) ?? null;
      const activeProviderLabel = hostedActive ? hostedActive.providerLabel : displayProvider?.label;
      optionsByScope[scope] = hostedActive ? [...hostedOptions, ...options] : [...options, ...hostedOptions];
      labelByScope[scope] = active
        ? [activeProviderLabel, active.label].filter(Boolean).join(' · ')
        : (options.length > 0 ? 'Select auth' : 'No auth');
    });

    return {
      optionsByScope,
      labelByScope,
    };
  }, [activeHostedChoice, composerSelections, desktopAuthState, hostedAccounts, resolveComposerProviderId]);

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

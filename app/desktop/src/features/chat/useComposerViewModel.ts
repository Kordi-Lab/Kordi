import { useCallback, useMemo } from 'react';

import { buildAuthDisplayProviders } from '@/kordi-app/auth/model';
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
  const chatModelOptions = useMemo<ComposerModelOption[]>(() => {
    if (!isNativeShell || !desktopChatState?.modelOptions.length) {
      return [];
    }

    return desktopChatState.modelOptions.map((option) => ({
      value: option.value,
      label: option.label,
      detail: option.detail,
      provider: option.provider,
      providerLabel: option.providerLabel,
    }));
  }, [desktopChatState?.modelOptions, isNativeShell]);

  const composerProviderOptions = useMemo<ComposerProviderOption[]>(() => {
    const displayProviders = buildAuthDisplayProviders(desktopAuthState);
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
          detail: null,
          selectionLabel: provider.label,
          active: false,
        }];
      })
      .filter((option) => providerLabels.has(option.providerId) || chatModelOptions.some((model) => model.provider === option.providerId));
  }, [chatModelOptions, desktopAuthState]);

  const preferredModelValueForProvider = useCallback((providerId: string) => {
    const providerModels = chatModelOptions.filter((option) => option.provider === providerId);
    if (providerModels.length === 0) return null;

    const preferredNeedles = providerId === 'anthropic'
      ? ['claude-opus-4-7', 'claude-opus-4.7', 'claude-opus-4-6', 'claude-opus']
      : providerId === 'openai'
        ? ['gpt-5.4', 'gpt-5-4', 'gpt-5']
        : [];

    for (const needle of preferredNeedles) {
      const match = providerModels.find((option) => option.label.toLowerCase().includes(needle));
      if (match) return match.value;
    }

    return providerModels[0]?.value ?? null;
  }, [chatModelOptions]);

  const resolveComposerProviderId = useCallback((_: ComposerScope, modelLabel: string) => {
    const option = desktopChatState?.modelOptions.find((candidate) => candidate.value === modelLabel);
    if (option) return option.provider;

    const normalized = modelLabel.toLowerCase();
    if (normalized.includes('claude')) return 'anthropic';
    if (normalized.includes('gemini')) return 'google';
    if (normalized.includes('groq')) return 'groq';
    if (normalized.includes('openrouter')) return 'openrouter';
    if (normalized.includes('xai') || normalized.includes('grok')) return 'xai';
    return 'openai';
  }, [desktopChatState?.modelOptions]);

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

import { useMemo } from 'react';

import {
  buildAuthDisplayProviders,
  normalizeSelectedProviderId,
} from '@/kordi-app/auth/model';
import type { ComposerAuthOption, ComposerModelOption } from '@/kordi-app/components';
import type { ComposerScope, DesktopAuthState } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

type DefaultCloudAgentRuntimeRouteArgs = {
  activeLoginProviderId: string | null;
  authOptions: ComposerAuthOption[];
  chatModelOptions: ComposerModelOption[];
  desktopAuthState: DesktopAuthState | null;
  isNativeShell: boolean;
  preferredModelValueForProvider: (providerId: string) => string | null;
  resolveComposerProviderId: (scope: ComposerScope, modelLabel: string) => string;
  selectedModel: string;
  selectedThinking?: string | null;
};

export function resolveDefaultCloudAgentRuntimeRoute({
  activeLoginProviderId,
  authOptions,
  chatModelOptions,
  desktopAuthState,
  isNativeShell,
  preferredModelValueForProvider,
  resolveComposerProviderId,
  selectedModel,
  selectedThinking,
}: DefaultCloudAgentRuntimeRouteArgs): DesktopChatMessageRoute | null {
  if (!isNativeShell) return null;

  const authProviders = buildAuthDisplayProviders(desktopAuthState);
  const chatModel = selectedModel.trim();
  const selectedProviderId = chatModel ? resolveComposerProviderId('chat', chatModel) : null;
  const normalizedSelectedProviderId =
    normalizeSelectedProviderId(selectedProviderId) ?? selectedProviderId;
  const selectedProvider = normalizedSelectedProviderId
    ? authProviders.find((provider) => provider.id === normalizedSelectedProviderId)
    : null;
  const selectedModelIsAvailable = chatModelOptions.some((option) => option.value === chatModel);

  let routeModel: string | null =
    selectedProvider?.configured && selectedModelIsAvailable ? chatModel : null;
  let routeProviderId: string | null = selectedProvider?.configured ? selectedProviderId : null;

  if (!routeModel) {
    const normalizedActiveProviderId = normalizeSelectedProviderId(activeLoginProviderId);
    const fallbackProvider =
      authProviders.find(
        (provider) => provider.configured && provider.id === normalizedActiveProviderId,
      )
      ?? authProviders.find(
        (provider) =>
          provider.configured
          && provider.methods.some((method) => method.options.some((option) => option.active)),
      )
      ?? authProviders.find((provider) => provider.configured)
      ?? null;
    routeProviderId = fallbackProvider?.id ?? null;
    routeModel = routeProviderId ? preferredModelValueForProvider(routeProviderId) : null;
  }

  if (!routeModel) return null;

  const modelProviderId = routeProviderId ?? routeModel.split('/')[0] ?? null;
  const normalizedModelProviderId =
    normalizeSelectedProviderId(modelProviderId) ?? modelProviderId;
  const matchingAuthOptions = authOptions.filter(
    (option) =>
      (normalizeSelectedProviderId(option.providerId) ?? option.providerId)
      === normalizedModelProviderId,
  );
  const authOption =
    matchingAuthOptions.find((option) => option.active) ?? matchingAuthOptions[0] ?? null;

  return {
    model: routeModel,
    authProvider: authOption?.providerId ?? routeProviderId,
    authChoice: authOption?.value ?? null,
    thinking: selectedThinking ?? null,
  };
}

export function useKordiDefaultCloudAgentRuntimeRoute(
  args: DefaultCloudAgentRuntimeRouteArgs,
) {
  const {
    activeLoginProviderId,
    authOptions,
    chatModelOptions,
    desktopAuthState,
    isNativeShell,
    preferredModelValueForProvider,
    resolveComposerProviderId,
    selectedModel,
    selectedThinking,
  } = args;

  return useMemo(
    () => resolveDefaultCloudAgentRuntimeRoute({
      activeLoginProviderId,
      authOptions,
      chatModelOptions,
      desktopAuthState,
      isNativeShell,
      preferredModelValueForProvider,
      resolveComposerProviderId,
      selectedModel,
      selectedThinking,
    }),
    [
      activeLoginProviderId,
      authOptions,
      chatModelOptions,
      desktopAuthState,
      isNativeShell,
      preferredModelValueForProvider,
      resolveComposerProviderId,
      selectedModel,
      selectedThinking,
    ],
  );
}

import { useMemo } from 'react';

import {
  buildAuthDisplayProviders,
  normalizeSelectedProviderId,
} from '@/kordi-app/auth/model';
import type { ComposerAuthOption, ComposerModelOption } from '@/kordi-app/components';
import type { ComposerScope, DesktopAuthState } from '@/kordi-app/types';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { DEVICE_ACTIVE_CHOICES, isAccountAuthChoice, isHostedOnlyAccountChoice } from '@/features/cloud/routeAccountChoice';
import { registeredAccountChoices } from '@/features/cloud/hostedAccountRegistry';

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

export function portableCloudAgentAuthChoice(
  choice?: string | null,
  methodLabel?: string | null,
) {
  const value = choice?.trim();
  if (!value) return null;
  // Account choices (profile:, ios-codex:, ios-api-key:, cloud-api-key:,
  // cloud-login:) and device-active aliases are portable as they are.
  if (isAccountAuthChoice(value) || DEVICE_ACTIVE_CHOICES.has(value)) return value;
  const method = methodLabel?.trim().toLowerCase() ?? '';
  if (method.includes('oauth')) return 'local-active-oauth';
  if (method.includes('api key')) return 'local-active-api-key';
  return null;
}

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
  // A Custom API model, or a provider this Mac has no account for, runs on its
  // hosted account and never falls back to another provider's model.
  const hostedOptions = authOptions.filter((option) => (
    (option.providerId === selectedProviderId || option.providerId === normalizedSelectedProviderId)
    && isHostedOnlyAccountChoice(option.value, registeredAccountChoices())
  ));
  if (normalizedSelectedProviderId === 'custom' || (hostedOptions.length > 0 && !selectedProvider?.configured)) {
    const account = hostedOptions.find((option) => option.active) ?? hostedOptions[0];
    return account && chatModel.includes('/')
      ? { model: chatModel, authProvider: account.providerId, authChoice: account.value, thinking: selectedThinking ?? null }
      : null;
  }
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
    authChoice: portableCloudAgentAuthChoice(
      authOption?.value,
      authOption?.methodLabel,
    ),
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

import { portableCloudAgentAuthChoice } from '@/app/useKordiDefaultCloudAgentRuntimeRoute';
import type { ComposerAuthOption } from '@/kordi-app/components';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

import {
  compactCloudAgentRuntimeRoute,
  type CloudAgentRuntimeRouteChangeInput,
} from './cloudAgentRuntime';
import { canonicalCloudProviderId } from './providerAuthSnapshot';
import { isAccountAuthChoice } from './routeAccountChoice';

export function resolveCloudAgentRuntimeRouteChange({
  authOptions,
  input,
  resolvedLocalRoute,
}: {
  authOptions: readonly ComposerAuthOption[];
  input: CloudAgentRuntimeRouteChangeInput;
  resolvedLocalRoute: DesktopChatMessageRoute | null;
}): DesktopChatMessageRoute | null {
  const model = input.model.trim();
  const modelProvider = model.includes('/')
    ? model.slice(0, model.indexOf('/')).trim()
    : null;
  const inputProvider = input.authProvider?.trim() || null;
  const inputProviderMatchesModel = Boolean(
    inputProvider
    && modelProvider
    && canonicalCloudProviderId(inputProvider)
      === canonicalCloudProviderId(modelProvider),
  );
  // A route that names one account keeps it, even when this device cannot
  // see that account: another account is never substituted silently.
  const inputChoice = input.authChoice?.trim() ?? '';
  if (inputProvider && isAccountAuthChoice(inputChoice) && (!modelProvider || inputProviderMatchesModel)) {
    return compactCloudAgentRuntimeRoute({
      model: modelProvider ? model : `${inputProvider}/${model}`,
      thinking: input.thinking ?? resolvedLocalRoute?.thinking ?? null,
      authProvider: inputProvider,
      authChoice: inputChoice,
    });
  }
  const resolvedProvider = resolvedLocalRoute?.authProvider?.trim() ?? null;
  const resolvedProviderMatchesModel = Boolean(
    resolvedProvider
    && modelProvider
    && canonicalCloudProviderId(resolvedProvider)
      === canonicalCloudProviderId(modelProvider),
  );
  if (
    modelProvider
    && resolvedProvider
    && !resolvedProviderMatchesModel
    && resolvedLocalRoute?.model
    && resolvedLocalRoute.authChoice
  ) {
    return compactCloudAgentRuntimeRoute({
      ...resolvedLocalRoute,
      thinking: input.thinking ?? resolvedLocalRoute.thinking ?? null,
    });
  }
  const inputAuthOption = inputProvider
    ? authOptions.find(
        (option) => option.value === input.authChoice
          && option.providerId === inputProvider,
      )
    : null;
  const preferInputProvider = Boolean(
    inputProviderMatchesModel
    && (
      !resolvedProviderMatchesModel
      || inputProvider === resolvedProvider
      || inputAuthOption
    ),
  );
  const requestedProvider = (modelProvider
    ? (preferInputProvider
        ? inputProvider
        : resolvedProviderMatchesModel
          ? resolvedProvider
          : modelProvider)
    : inputProvider)
    || resolvedLocalRoute?.authProvider
    || null;
  const providersMatch = Boolean(
    requestedProvider
    && resolvedProvider
    && canonicalCloudProviderId(requestedProvider)
      === canonicalCloudProviderId(resolvedProvider),
  );
  const inputProviderMatchesRequest = Boolean(
    inputProvider
    && requestedProvider
    && canonicalCloudProviderId(inputProvider)
      === canonicalCloudProviderId(requestedProvider),
  );
  const requestedAuthOption = inputProviderMatchesRequest
    ? authOptions.find(
        (option) => option.value === input.authChoice
          && canonicalCloudProviderId(option.providerId)
            === canonicalCloudProviderId(requestedProvider),
      )
    : null;
  const requestedAuthChoice = inputProviderMatchesRequest
    ? portableCloudAgentAuthChoice(
        input.authChoice,
        requestedAuthOption?.methodLabel,
      )
    : null;
  return compactCloudAgentRuntimeRoute({
    model: requestedProvider && !model.includes('/')
      ? `${requestedProvider}/${model}`
      : model,
    thinking: input.thinking ?? resolvedLocalRoute?.thinking ?? null,
    authProvider: requestedProvider,
    authChoice: requestedAuthChoice
      ?? (providersMatch ? resolvedLocalRoute?.authChoice : null),
  });
}

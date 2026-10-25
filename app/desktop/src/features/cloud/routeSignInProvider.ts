import type { ComposerAuthOption } from '@/kordi-app/components';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

import { canonicalCloudProviderId } from './providerAuthSnapshot';
import { isAccountAuthChoice } from './routeAccountChoice';

/**
 * Routes rebuilt after a restart could record the provider family (`openai`)
 * for a ChatGPT sign-in (`openai-codex`). The named sign-in's own provider wins.
 */
export function routeWithSignInProvider<Route extends DesktopChatMessageRoute | null>(
  route: Route,
  authOptions: readonly ComposerAuthOption[],
): Route {
  const choice = route?.authChoice?.trim() ?? '';
  const provider = route?.authProvider?.trim() ?? '';
  if (!route || !provider || !isAccountAuthChoice(choice)) return route;
  const signIn = authOptions.find((option) => option.value === choice);
  if (
    !signIn
    || signIn.providerId === provider
    || canonicalCloudProviderId(signIn.providerId) !== canonicalCloudProviderId(provider)
  ) return route;
  return { ...route, authProvider: signIn.providerId };
}

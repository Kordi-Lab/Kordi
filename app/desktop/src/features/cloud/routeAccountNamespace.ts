import { modelInAccountNamespace } from '@/kordi-app/components/composerModelSelection';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

/**
 * A route whose model sits in another namespace of the account's provider
 * family (for example `openai/…` on an `openai-codex` account) runs the
 * account's own model of the same id when the catalog offers it.
 */
export function routeWithAccountNamespace<Route extends DesktopChatMessageRoute | null>(
  route: Route,
  chatModelOptions: readonly { value: string }[],
): Route {
  const model = route?.model?.trim() ?? '';
  if (!route || !model) return route;
  const accountModel = modelInAccountNamespace(model, route.authProvider, chatModelOptions);
  return accountModel === model ? route : { ...route, model: accountModel };
}

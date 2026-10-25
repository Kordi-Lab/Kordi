import { normalizeComposerProviderId } from '@/kordi-app/components/composerModelSelection';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

/**
 * A stored route whose model sits in another namespace of the account's
 * provider family (for example `openai/…` on an `openai-codex` account) runs
 * the account's own model of the same id when the catalog offers it.
 */
export function routeWithAccountNamespace<Route extends DesktopChatMessageRoute | null>(
  route: Route,
  chatModelOptions: readonly { value: string }[],
): Route {
  const model = route?.model?.trim() ?? '';
  const authProvider = route?.authProvider?.trim() ?? '';
  const separator = model.indexOf('/');
  if (!route || !authProvider || separator <= 0) return route;
  const namespace = model.slice(0, separator);
  if (namespace === authProvider || normalizeComposerProviderId(namespace) !== normalizeComposerProviderId(authProvider)) return route;
  const accountModel = `${authProvider}/${model.slice(separator + 1)}`;
  return chatModelOptions.some((option) => option.value === accountModel) ? { ...route, model: accountModel } : route;
}

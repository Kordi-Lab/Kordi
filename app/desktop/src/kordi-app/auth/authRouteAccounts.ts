import { CUSTOM_MODEL_REQUIRED, CUSTOM_PROVIDER_ID } from './customApiAccount';
import { isLocalProvider, type AuthDisplayProvider } from './model';

/** One saved account with the models its OMP provider offers. */
export type RouteAccount = {
  value: string;
  label: string;
  active: boolean;
  /** Stored in the Kordi account rather than on this Mac. */
  hosted: boolean;
  providerId: string;
  modelIds: string[];
  modelHint: string | null;
  suggestedModel: string;
};

// One display provider can hold accounts for several OMP providers (ChatGPT
// sign-in and OpenAI API keys), so each account carries its own model list.
export function routeAccounts(provider: AuthDisplayProvider): RouteAccount[] {
  return provider.methods.flatMap((method) => {
    const modelIds = method.modelIds ?? provider.modelIds ?? [];
    const defaultModelId = method.defaultModelId ?? provider.defaultModelId;
    const preferred = provider.preferredModel?.startsWith(`${method.providerId}/`)
      ? provider.preferredModel.slice(method.providerId.length + 1) : '';
    const fallback = modelIds.includes(preferred) ? preferred
      : defaultModelId && modelIds.includes(defaultModelId) ? defaultModelId : modelIds[0] ?? '';
    return method.options.filter((option) => option.profileId).map((option) => {
      const modelHint = option.modelHint && (!modelIds.length || modelIds.includes(option.modelHint)) ? option.modelHint : null;
      return {
        value: option.value, label: option.label, active: option.active, hosted: option.source === 'Cloud',
        providerId: method.providerId, modelIds, modelHint, suggestedModel: modelHint ?? fallback,
      };
    });
  });
}

export function hasActiveAccount(provider: AuthDisplayProvider) {
  return provider.methods.some((method) => method.options.some((option) => option.active));
}

/**
 * What Start chat opens: the active account, else the first saved one, with
 * its preferred or default model as a `provider/model` value. Null without an account.
 */
export function startChatTarget(provider: AuthDisplayProvider): { account: RouteAccount; model: string | null } | null {
  const accounts = routeAccounts(provider);
  const account = accounts.find((item) => item.active) ?? accounts[0];
  if (!account) return null;
  return { account, model: account.suggestedModel ? `${account.providerId}/${account.suggestedModel}` : null };
}

/** Why Start chat is off for this provider, or null when it can open a chat. */
export function startChatBlockedReason(provider: AuthDisplayProvider): string | null {
  const target = startChatTarget(provider);
  if (!target) return 'Add an account to start a chat.';
  // A Custom API endpoint has no catalog default; without its model the chat has nothing to send with.
  if (target.account.providerId === CUSTOM_PROVIDER_ID && !target.model) return CUSTOM_MODEL_REQUIRED;
  return null;
}

/**
 * Continue to chat keeps the owner's chat while this Mac has its own access.
 * With hosted accounts only, it opens the first connected provider that can
 * chat, or the page of one that cannot yet, to show what is missing.
 */
export function continueChatProvider(providers: AuthDisplayProvider[]): { provider: AuthDisplayProvider; blocked: boolean } | null {
  const connected = providers.filter((item) => item.configured);
  const localAccess = connected.some((item) => isLocalProvider(item.id)
    || item.methods.some((method) => method.options.some((option) => option.source !== 'Cloud')));
  if (localAccess || connected.length === 0) return null;
  const ready = connected.find((item) => !startChatBlockedReason(item));
  return ready ? { provider: ready, blocked: false } : { provider: connected[0], blocked: true };
}

/**
 * Hosted accounts have no active flag on this Mac. The page remembers the one
 * it made active and shows it as active while no other account is.
 */
export function withActiveAccount(provider: AuthDisplayProvider, choice: string | null | undefined): AuthDisplayProvider {
  if (!choice || hasActiveAccount(provider)) return provider;
  if (!provider.methods.some((method) => method.options.some((option) => option.value === choice))) return provider;
  return {
    ...provider,
    methods: provider.methods.map((method) => ({
      ...method,
      options: method.options.map((option) => (option.value === choice ? { ...option, active: true } : option)),
    })),
  };
}

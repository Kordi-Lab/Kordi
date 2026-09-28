import { canonicalCloudProviderId } from '@/features/cloud/providerAuthSnapshot';
import { routeRunsOnKordiCloud } from '@/features/cloud/cloudAgentRuntimeRoute';
import type { HostedAccount } from '@/features/cloud/hostedAccounts';
import { hasHostedOnlyPrefix } from '@/features/cloud/routeAccountChoice';
import { ompProviderIdFor, ompProviderName, type OmpCatalogEntry } from '@/kordi-app/auth/ompCatalog';
import { providerShortName } from '@/kordi-app/auth/providerCopy';
import type { ComposerAuthOption, ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import { normalizeComposerProviderId } from '@/kordi-app/components/composerModelSelection';
import type { DesktopChatMessageRoute } from '@/lib/desktop';

// The composer lists every hosted account the provider page lists. Each runs
// on Kordi Cloud with its stored model and, outside Custom API, the models the
// pinned OMP catalog lists for its provider. A Custom API endpoint serves only
// the model its account stores.

export const CUSTOM_ROUTE_PROVIDER = 'custom';
export const KORDI_CLOUD_ACCOUNT_DETAIL = 'Runs on Kordi Cloud';
export const RECONNECT_ACCOUNT_REASON = 'Account needs reconnecting';
const catalogThinkingLevels = ['off', 'low', 'medium', 'high'];

export function isCustomRouteModel(model: string) {
  return model.trim().startsWith(`${CUSTOM_ROUTE_PROVIDER}/`);
}

/** A hosted account with the provider id and models its routes use. */
export type HostedRouteAccount = HostedAccount & { providerId: string; providerLabel: string; models: string[] };

function catalogProviderId(account: HostedAccount, ids: ReadonlySet<string>) {
  if (account.provider === CUSTOM_ROUTE_PROVIDER) return CUSTOM_ROUTE_PROVIDER;
  if (canonicalCloudProviderId(account.provider) === 'openai' && account.authChoice.includes('codex') && ids.has('openai-codex')) {
    return 'openai-codex';
  }
  return ompProviderIdFor(account.provider, ids) ?? account.provider;
}

/**
 * Hosted accounts without a counterpart on this Mac, as the composer offers
 * them. While this Mac's accounts have not loaded (`localChoices` null), only
 * accounts whose choice is hosted-only by prefix are offered.
 */
export function hostedRouteAccounts(
  accounts: HostedAccount[],
  catalog: OmpCatalogEntry[],
  localChoices: ReadonlySet<string> | null = new Set(),
): HostedRouteAccount[] {
  const ids = new Set(catalog.map((entry) => entry.id));
  const offered = (account: HostedAccount) => (localChoices === null
    ? hasHostedOnlyPrefix(account.authChoice)
    : !localChoices.has(account.authChoice));
  return accounts.filter(offered).map((account) => {
    const providerId = catalogProviderId(account, ids);
    const entry = catalog.find((item) => item.id === providerId);
    const custom = providerId === CUSTOM_ROUTE_PROVIDER;
    const models = custom ? [] : entry?.models ?? [];
    return {
      ...account,
      providerId,
      providerLabel: custom ? 'Custom API' : providerShortName(ompProviderName(providerId, entry)),
      models: [...new Set([account.model, ...models].filter((model): model is string => Boolean(model)))],
    };
  });
}

/** The model a hosted account opens with: its stored model, else its provider's default. */
function accountDefaultModel(account: HostedRouteAccount, catalog?: OmpCatalogEntry[]) {
  const entry = catalog?.find((item) => item.id === account.providerId);
  const preferred = entry?.defaultModel && account.models.includes(entry.defaultModel) ? entry.defaultModel : null;
  return account.model ?? preferred ?? account.models[0] ?? null;
}

export function hostedModelOptions(accounts: HostedRouteAccount[]): ComposerModelOption[] {
  const options: ComposerModelOption[] = [];
  for (const account of accounts) {
    if (account.needsReconnect) continue;
    for (const model of account.models) {
      const value = `${account.providerId}/${model}`;
      if (options.some((option) => option.value === value)) continue;
      options.push({
        value, label: model, detail: `${account.providerLabel} • ${KORDI_CLOUD_ACCOUNT_DETAIL}`,
        provider: normalizeComposerProviderId(account.providerId), providerLabel: account.providerLabel,
        thinkingLevels: account.providerId === CUSTOM_ROUTE_PROVIDER ? ['off'] : catalogThinkingLevels,
      });
    }
  }
  return options;
}

/** One entry per hosted account under its provider; one that needs reconnecting stays listed but off. */
export function hostedProviderOptions(accounts: HostedRouteAccount[], activeChoice: string | null): ComposerProviderOption[] {
  return accounts.map((account) => ({
    value: `${account.providerId}::${account.authChoice}`,
    providerId: account.providerId,
    label: account.label,
    detail: `${account.providerLabel} · ${account.needsReconnect ? RECONNECT_ACCOUNT_REASON : KORDI_CLOUD_ACCOUNT_DETAIL}`,
    selectionLabel: `${account.providerLabel} • ${account.label}`,
    active: account.authChoice === activeChoice,
    ...(account.needsReconnect ? { disabled: true, disabledReason: RECONNECT_ACCOUNT_REASON } : {}),
  }));
}

export function hostedAuthOptions(accounts: HostedRouteAccount[], activeChoice: string | null): ComposerAuthOption[] {
  return accounts.filter((account) => !account.needsReconnect).map((account) => ({
    providerId: account.providerId,
    providerLabel: account.providerLabel,
    methodLabel: KORDI_CLOUD_ACCOUNT_DETAIL,
    value: account.authChoice,
    label: account.label,
    detail: `${account.providerLabel} · ${KORDI_CLOUD_ACCOUNT_DETAIL}`,
    active: account.authChoice === activeChoice,
  }));
}

function routeFor(account: HostedRouteAccount, model: string, thinking?: string | null): DesktopChatMessageRoute {
  return { model: `${account.providerId}/${model}`, authProvider: account.providerId, authChoice: account.authChoice, thinking: thinking ?? null };
}

/** The Kordi Cloud route for choosing a hosted account: the requested model when it serves it, else its default. */
export function hostedRouteForChoice(
  account: HostedRouteAccount,
  options: { model?: string | null; thinking?: string | null; catalog?: OmpCatalogEntry[] } = {},
): DesktopChatMessageRoute | null {
  if (account.needsReconnect) return null;
  const requested = options.model?.startsWith(`${account.providerId}/`) ? options.model.slice(account.providerId.length + 1) : null;
  const model = requested && account.models.includes(requested) ? requested : accountDefaultModel(account, options.catalog);
  return model ? routeFor(account, model, options.thinking) : null;
}

function sameProvider(left: string, right: string) {
  return left === right || normalizeComposerProviderId(left) === normalizeComposerProviderId(right);
}

/**
 * The hosted route for a model choice: the session's hosted account while it
 * serves the model, the Custom API account serving it, or the provider's
 * hosted account when this Mac has none for it. Null keeps the local runtime.
 */
export function hostedRouteForModel({
  accounts, model, thinking, currentRoute, localProviderIds = new Set(),
}: {
  accounts: HostedRouteAccount[];
  model: string;
  thinking?: string | null;
  currentRoute?: DesktopChatMessageRoute | null;
  localProviderIds?: ReadonlySet<string>;
}): DesktopChatMessageRoute | null {
  const separator = model.indexOf('/');
  if (separator <= 0) return null;
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  const usable = accounts.filter((account) => !account.needsReconnect && account.models.includes(modelId) && sameProvider(account.providerId, provider));
  const current = routeRunsOnKordiCloud(currentRoute)
    ? usable.find((account) => account.authChoice === currentRoute?.authChoice)
    : null;
  if (current) return routeFor(current, modelId, thinking);
  const hostedOnlyProvider = provider === CUSTOM_ROUTE_PROVIDER || ![...localProviderIds].some((id) => sameProvider(id, provider));
  return hostedOnlyProvider && usable[0] ? routeFor(usable[0], modelId, thinking) : null;
}

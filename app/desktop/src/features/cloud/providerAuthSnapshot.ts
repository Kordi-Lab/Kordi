import type { CloudProviderAuthSnapshotInput } from './authClient';
import type { DesktopAuthState } from '@/kordi-app/types';

type ProviderAuthProfiles = Record<string, Record<string, unknown>>;

export type BuildCloudProviderAuthSnapshotInputOptions = {
  enabled: boolean;
  activeProvider?: string | null;
  activeAuthChoice?: string | null;
  authProfiles?: ProviderAuthProfiles | null;
};

export type CloudProviderAuthSnapshotRoute = {
  model?: string | null;
  authProvider?: string | null;
  authChoice?: string | null;
};

export type CloudProviderAuthReconciliationTarget = {
  provider: string;
  queryProviderIds: string[];
  configured: boolean;
  authChoice: string | null;
  model: string | null;
};

const MAC_ONLY_PROVIDER_IDS = new Set([
  'github-copilot',
  'lm-studio',
  'ollama',
]);

function cleanText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function canonicalCloudProviderId(value?: string | null): string | null {
  const normalized = cleanText(value)?.toLowerCase() ?? null;
  if (normalized === 'openai-codex' || normalized === 'codex') return 'openai';
  if (normalized === 'google-gemini') return 'google';
  return normalized;
}

export function cloudProviderAuthQueryProviderIds(providerId: string): string[] {
  switch (canonicalCloudProviderId(providerId)) {
    case 'openai': return ['openai', 'openai-codex', 'codex'];
    case 'google': return ['google', 'google-gemini'];
    default: return [canonicalCloudProviderId(providerId) ?? providerId.trim().toLowerCase()];
  }
}

export function cloudProviderAuthReconciliationTargets(
  authState: DesktopAuthState | null | undefined,
  route: CloudProviderAuthSnapshotRoute | null | undefined,
): CloudProviderAuthReconciliationTarget[] {
  if (!authState) return [];
  const routeProvider = canonicalCloudProviderId(route?.authProvider);
  return authState.providers.flatMap((provider) => {
    const providerId = canonicalCloudProviderId(provider.id);
    if (!providerId || MAC_ONLY_PROVIDER_IDS.has(providerId)) return [];
    const activeOption = provider.options.find((option) => option.active)
      ?? provider.options[0]
      ?? null;
    const routeOwnsProvider = routeProvider === providerId;
    return [{
      provider: providerId,
      queryProviderIds: cloudProviderAuthQueryProviderIds(providerId),
      configured: provider.configured,
      authChoice: routeOwnsProvider
        ? cleanText(route?.authChoice) ?? cleanText(activeOption?.value)
        : cleanText(activeOption?.value),
      model: routeOwnsProvider
        ? cleanText(route?.model) ?? cleanText(provider.preferredModel)
        : cleanText(provider.preferredModel),
    }];
  });
}

export function cloudProviderAuthReconciliationSignature(
  accountId: string | null | undefined,
  targets: readonly CloudProviderAuthReconciliationTarget[],
): string | null {
  const account = cleanText(accountId);
  if (!account || targets.length === 0) return null;
  return [
    account,
    ...targets.map((target) => [
      target.provider,
      target.configured ? 'configured' : 'removed',
      target.authChoice ?? '',
      target.model ?? '',
    ].join(':')),
  ].join('|');
}

export function buildCloudProviderAuthSnapshotInput(
  options: BuildCloudProviderAuthSnapshotInputOptions,
): CloudProviderAuthSnapshotInput | null {
  if (!options.enabled) return null;
  const provider = cleanText(options.activeProvider)?.toLowerCase() ?? null;
  const authChoice = cleanText(options.activeAuthChoice);
  if (!provider || !authChoice) return null;
  const payload = options.authProfiles?.[provider]?.[authChoice];
  if (!payload || typeof payload !== 'object') return null;
  return { provider, authChoice, payload };
}

export function shouldPublishCloudProviderAuthSnapshot(
  enabled: boolean,
  input: CloudProviderAuthSnapshotInput | null,
): boolean {
  return Boolean(enabled && input);
}

export function cloudProviderAuthSnapshotRouteSignature(
  accountId: string | null | undefined,
  route: CloudProviderAuthSnapshotRoute | null | undefined,
): string | null {
  const account = cleanText(accountId);
  const provider = canonicalCloudProviderId(route?.authProvider);
  const authChoice = cleanText(route?.authChoice);
  const model = cleanText(route?.model);
  if (!account || !provider) return null;
  return [account, provider, authChoice ?? '', model ?? ''].join('|');
}

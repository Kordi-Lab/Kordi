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

export type CloudProviderAuthSyncTarget = {
  provider: string;
  authChoice: string;
  model: string | null;
  active: boolean;
};

function cleanText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizedProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'openai-codex') return 'openai';
  if (normalized === 'anthropic-oauth') return 'anthropic';
  return normalized;
}

function syncProviderForMethod(provider: string, method: string): string {
  const normalized = normalizedProvider(provider);
  if (normalized !== 'openai') return normalized;
  return method.trim().toLowerCase() === 'oauth' ? 'openai-codex' : 'openai';
}

export function cloudProviderAuthSyncTargets(
  authState: DesktopAuthState | null | undefined,
): CloudProviderAuthSyncTarget[] {
  if (!authState) return [];
  const targets = new Map<string, CloudProviderAuthSyncTarget>();
  for (const provider of authState.providers) {
    const normalized = normalizedProvider(provider.id);
    if (normalized === 'lm-studio' || normalized === 'ollama') continue;
    for (const option of provider.options) {
      const profileId = cleanText(option.profileId);
      const source = option.source.trim().toLowerCase();
      if (!profileId || !source.startsWith('kordi')) continue;
      const syncProvider = syncProviderForMethod(provider.id, option.method);
      const authChoice = `profile:${profileId}`;
      const key = `${syncProvider}|${authChoice}`;
      targets.set(key, {
        provider: syncProvider,
        authChoice,
        model: cleanText(provider.preferredModel),
        active: option.active,
      });
    }
  }
  return [...targets.values()].sort((left, right) => (
    `${left.provider}|${left.authChoice}`.localeCompare(`${right.provider}|${right.authChoice}`)
  ));
}

function replacementAuthChoice(
  provider: string,
  authChoice: string,
  targets: CloudProviderAuthSyncTarget[],
): string | null {
  const normalizedRouteProvider = normalizedProvider(provider);
  const candidates = targets.filter((target) => (
    normalizedProvider(target.provider) === normalizedRouteProvider
  ));
  if (candidates.some((target) => target.authChoice === authChoice)) {
    return null;
  }
  if (candidates.length === 1) return candidates[0]?.authChoice ?? null;
  const activeCandidates = candidates.filter((target) => target.active);
  return activeCandidates.length === 1
    ? activeCandidates[0]?.authChoice ?? null
    : null;
}

/**
 * Repairs persisted agent routes after a saved OAuth/API-key profile is
 * replaced. A replacement is selected only when it is unambiguous; an agent
 * with multiple eligible profiles must keep its explicit user selection.
 */
export function retargetCloudAgentModelRoutingForAuthState(
  modelRouting: Record<string, unknown>,
  authState: DesktopAuthState | null | undefined,
): Record<string, unknown> | null {
  const targets = cloudProviderAuthSyncTargets(authState);
  if (targets.length === 0) return null;

  let changed = false;
  const next = { ...modelRouting };
  for (const prefix of ['default', 'fallback'] as const) {
    const providerKey = `${prefix}AuthProvider`;
    const choiceKey = `${prefix}AuthChoice`;
    const provider = cleanText(
      typeof modelRouting[providerKey] === 'string'
        ? modelRouting[providerKey]
        : null,
    );
    const authChoice = cleanText(
      typeof modelRouting[choiceKey] === 'string'
        ? modelRouting[choiceKey]
        : null,
    );
    if (!provider || !authChoice) continue;
    const replacement = replacementAuthChoice(
      provider,
      authChoice,
      targets,
    );
    if (!replacement || replacement === authChoice) continue;
    next[choiceKey] = replacement;
    changed = true;
  }
  return changed ? next : null;
}

export function cloudProviderAuthSnapshotIdentity(
  provider: string,
  authChoice: string,
): string {
  return `${provider.trim().toLowerCase()}|${authChoice.trim()}`;
}

export function canReconcileCloudProviderAuthManifest(
  accountId: string | null | undefined,
  restoredAccountId: string | null | undefined,
): boolean {
  const account = cleanText(accountId);
  return account !== null && account === cleanText(restoredAccountId);
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
  authRevision?: string | null,
): string | null {
  const account = cleanText(accountId);
  const provider = cleanText(route?.authProvider)?.toLowerCase() ?? null;
  const authChoice = cleanText(route?.authChoice);
  const model = cleanText(route?.model);
  if (!account || !provider) return null;
  return [
    account,
    provider,
    authChoice ?? '',
    model ?? '',
    cleanText(authRevision) ?? '',
  ].join('|');
}

export function cloudProviderAuthAccountRevision(
  authState: DesktopAuthState | null | undefined,
  route: CloudProviderAuthSnapshotRoute | null | undefined,
): string | null {
  const routeProvider = cleanText(route?.authProvider)?.toLowerCase() ?? null;
  if (!routeProvider || !authState) return null;
  const provider = authState.providers.find((candidate) => {
    const candidateId = candidate.id.trim().toLowerCase();
    if (candidateId === routeProvider) return true;
    return (candidateId === 'openai' || candidateId === 'openai-codex')
      && (routeProvider === 'openai' || routeProvider === 'openai-codex');
  });
  if (!provider?.configured) return null;
  return JSON.stringify({
    provider: provider.id,
    configured: provider.configured,
    options: provider.options.map((option) => ({
      value: option.value,
      profileId: option.profileId ?? null,
      active: option.active,
      configuredAtMs: option.configuredAtMs ?? null,
      updatedAtMs: option.updatedAtMs ?? null,
      accountLabel: option.accountLabel ?? null,
      authority: option.authority ?? null,
    })),
  });
}

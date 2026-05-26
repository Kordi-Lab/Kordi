import type { CloudProviderAuthSnapshotInput } from './authClient';

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

function cleanText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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
  const provider = cleanText(route?.authProvider)?.toLowerCase() ?? null;
  const authChoice = cleanText(route?.authChoice);
  const model = cleanText(route?.model);
  if (!account || !provider) return null;
  return [account, provider, authChoice ?? '', model ?? ''].join('|');
}

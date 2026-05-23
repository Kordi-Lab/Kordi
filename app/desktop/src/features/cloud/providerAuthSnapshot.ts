import type { CloudProviderAuthSnapshotInput } from './authClient';

type ProviderAuthProfiles = Record<string, Record<string, unknown>>;

export type BuildCloudProviderAuthSnapshotInputOptions = {
  enabled: boolean;
  activeProvider?: string | null;
  activeAuthChoice?: string | null;
  authProfiles?: ProviderAuthProfiles | null;
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

import { invokeDesktop, isNativeDesktopShell } from './desktopRuntime';

export type DesktopCloudProviderAuthRestoreResult = {
  restoredProfiles: number;
  removedProfiles: number;
  selectionChanged: boolean;
  restoredProviders: string[];
  syncRevision: string;
  changed: boolean;
};

export async function restoreDesktopCloudProviderAuth(
  accountId: string,
): Promise<DesktopCloudProviderAuthRestoreResult> {
  if (!isNativeDesktopShell()) {
    return {
      restoredProfiles: 0,
      removedProfiles: 0,
      selectionChanged: false,
      restoredProviders: [],
      syncRevision: '',
      changed: false,
    };
  }
  return invokeDesktop<DesktopCloudProviderAuthRestoreResult>(
    'desktop_cloud_provider_auth_restore',
    { accountId },
  );
}

export type DesktopCloudProviderAuthSnapshotPayload = {
  provider: string;
  authChoice: string;
  payload: Record<string, unknown>;
  credentialRevision: string;
};

export async function buildDesktopCloudProviderAuthSnapshotPayload(input: {
  accountId: string;
  provider?: string | null;
  authChoice?: string | null;
  model?: string | null;
  active?: boolean;
}) {
  if (!isNativeDesktopShell()) return null;
  return invokeDesktop<DesktopCloudProviderAuthSnapshotPayload>(
    'desktop_cloud_provider_auth_snapshot_payload',
    {
      accountId: input.accountId,
      provider: input.provider ?? null,
      authChoice: input.authChoice ?? null,
      model: input.model ?? null,
      active: input.active ?? false,
    },
  );
}

import {
  useEffect,
} from 'react';
import {
  buildDesktopCloudProviderAuthSnapshotPayload,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import type {
  CloudAccount,
  CloudAuthClient,
} from './authClient';
import {
  cloudProviderAuthSnapshotRouteSignature,
} from './providerAuthSnapshot';
import {
  loadSession,
} from './session';

const PROVIDER_AUTH_SNAPSHOT_REFRESH_MS = 30 * 60 * 1_000;

export function useCloudProviderAuthSnapshotSync({
  account,
  client,
  route,
  initialMessagesSettled,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  route: DesktopChatMessageRoute | null | undefined;
  initialMessagesSettled: boolean;
  reportWarning: (message: string, error: unknown) => void;
}) {
  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const syncKey = cloudProviderAuthSnapshotRouteSignature(
      account.accountId,
      route,
    );
    if (!syncKey) return;
    let cancelled = false;
    let publishing = false;
    const publish = async () => {
      if (publishing || cancelled) return;
      publishing = true;
      const session = await loadSession();
      if (!session?.token || cancelled) return;
      const input =
        await buildDesktopCloudProviderAuthSnapshotPayload({
          provider: route?.authProvider ?? null,
          authChoice: route?.authChoice ?? null,
          model: route?.model ?? null,
        });
      if (!input || cancelled) return;
      await client.publishProviderAuthSnapshot(
        session.token,
        input,
      );
    };
    const runPublish = () => {
      void publish()
        .catch((error) => {
          reportWarning(
            '[cloud-provider-auth-sync] publish failed',
            error,
          );
        })
        .finally(() => {
          publishing = false;
        });
    };
    runPublish();
    const refreshInterval = window.setInterval(
      runPublish,
      PROVIDER_AUTH_SNAPSHOT_REFRESH_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(refreshInterval);
    };
  }, [
    account,
    client,
    initialMessagesSettled,
    reportWarning,
    route,
  ]);
}

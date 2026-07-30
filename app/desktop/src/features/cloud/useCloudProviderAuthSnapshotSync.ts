import {
  useEffect,
  useRef,
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
  const syncedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    syncedKeysRef.current.clear();
  }, [account?.accountId]);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const syncKey = cloudProviderAuthSnapshotRouteSignature(
      account.accountId,
      route,
    );
    if (!syncKey || syncedKeysRef.current.has(syncKey)) return;
    syncedKeysRef.current.add(syncKey);
    let cancelled = false;
    void (async () => {
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
    })().catch((error) => {
      syncedKeysRef.current.delete(syncKey);
      reportWarning(
        '[cloud-provider-auth-sync] publish failed',
        error,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [
    account,
    client,
    initialMessagesSettled,
    reportWarning,
    route,
  ]);
}

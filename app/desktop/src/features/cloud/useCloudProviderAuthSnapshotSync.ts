import {
  useEffect,
  useReducer,
  useRef,
} from 'react';
import {
  buildDesktopCloudProviderAuthSnapshotPayload,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import type { DesktopAuthState } from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAuthClient,
} from './authClient';
import {
  cloudProviderAuthReconciliationSignature,
  cloudProviderAuthReconciliationTargets,
  cloudProviderAuthSnapshotRouteSignature,
} from './providerAuthSnapshot';
import {
  loadSession,
} from './session';

export type CloudProviderAuthSnapshotSyncOutcome =
  | 'complete'
  | 'not-ready'
  | 'stale';

type CloudProviderAuthSnapshotSyncTask = {
  key: string;
  promise: Promise<CloudProviderAuthSnapshotSyncOutcome>;
};

export class CloudProviderAuthSnapshotSyncGate {
  private accountId: string | null = null;
  private readonly completedKeys = new Set<string>();
  private inFlight: CloudProviderAuthSnapshotSyncTask | null = null;

  resetForAccount(accountId: string | null) {
    if (this.accountId === accountId) return;
    this.accountId = accountId;
    this.completedKeys.clear();
    this.inFlight = null;
  }

  start(
    accountId: string,
    key: string,
    work: () => Promise<CloudProviderAuthSnapshotSyncOutcome>,
  ): CloudProviderAuthSnapshotSyncTask | null {
    this.resetForAccount(accountId);
    if (this.completedKeys.has(key)) return null;
    if (this.inFlight) return this.inFlight;

    const promise = Promise.resolve()
      .then(work)
      .then((outcome) => {
        if (this.accountId === accountId && outcome === 'complete') {
          this.completedKeys.add(key);
        }
        return outcome;
      })
      .finally(() => {
        if (this.inFlight?.promise === promise) {
          this.inFlight = null;
        }
      });
    const task = { key, promise };
    this.inFlight = task;
    return task;
  }
}

type ReconcileCloudProviderAuthSnapshotsOptions = {
  accountId: string;
  client: CloudAuthClient;
  route: DesktopChatMessageRoute | null | undefined;
  desktopAuthState?: DesktopAuthState | null;
  isCurrent: () => boolean;
  loadStoredSession?: typeof loadSession;
  buildSnapshotPayload?: typeof buildDesktopCloudProviderAuthSnapshotPayload;
};

export async function reconcileCloudProviderAuthSnapshots({
  accountId,
  client,
  route,
  desktopAuthState,
  isCurrent,
  loadStoredSession = loadSession,
  buildSnapshotPayload = buildDesktopCloudProviderAuthSnapshotPayload,
}: ReconcileCloudProviderAuthSnapshotsOptions): Promise<CloudProviderAuthSnapshotSyncOutcome> {
  const session = await loadStoredSession();
  if (
    !session?.token
    || session.accountId !== accountId
    || !isCurrent()
  ) return 'not-ready';

  const reconciliationTargets = cloudProviderAuthReconciliationTargets(
    desktopAuthState,
    route,
  );
  const revokeAllForProvider = async (provider: string) => {
    for (let index = 0; index < 16; index += 1) {
      if (!isCurrent()) return false;
      const snapshot = await client.currentProviderAuthSnapshot(
        session.token,
        { provider },
      );
      if (!snapshot) return true;
      if (!isCurrent()) return false;
      await client.revokeProviderAuthSnapshot(
        session.token,
        snapshot.snapshotId,
      );
    }
    return true;
  };

  if (reconciliationTargets.length > 0) {
    for (const target of reconciliationTargets) {
      if (!isCurrent()) return 'stale';
      if (!target.configured) {
        for (const provider of target.queryProviderIds) {
          if (!await revokeAllForProvider(provider)) return 'stale';
        }
        continue;
      }

      const input = await buildSnapshotPayload({
        provider: target.provider,
        authChoice: target.authChoice,
        model: target.model,
      });
      if (!input) return 'not-ready';
      if (!isCurrent()) return 'stale';
      await client.publishProviderAuthSnapshot(
        session.token,
        input,
      );
    }
    return isCurrent() ? 'complete' : 'stale';
  }

  const input = await buildSnapshotPayload({
    provider: route?.authProvider ?? null,
    authChoice: route?.authChoice ?? null,
    model: route?.model ?? null,
  });
  if (!input) return 'not-ready';
  if (!isCurrent()) return 'stale';
  await client.publishProviderAuthSnapshot(session.token, input);
  return isCurrent() ? 'complete' : 'stale';
}

const PROVIDER_AUTH_SYNC_RETRY_MS = 1_500;

export function useCloudProviderAuthSnapshotSync({
  account,
  client,
  route,
  desktopAuthState,
  initialMessagesSettled,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  route: DesktopChatMessageRoute | null | undefined;
  desktopAuthState?: DesktopAuthState | null;
  initialMessagesSettled: boolean;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const syncGateRef = useRef<CloudProviderAuthSnapshotSyncGate | null>(null);
  if (syncGateRef.current == null) {
    syncGateRef.current = new CloudProviderAuthSnapshotSyncGate();
  }
  const activeAccountIdRef = useRef<string | null>(account?.accountId ?? null);
  const activeSyncKeyRef = useRef<string | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const [, retrySync] = useReducer((revision: number) => revision + 1, 0);

  useEffect(() => {
    activeAccountIdRef.current = account?.accountId ?? null;
    syncGateRef.current?.resetForAccount(account?.accountId ?? null);
  }, [account?.accountId]);

  useEffect(() => () => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    const reconciliationTargets = cloudProviderAuthReconciliationTargets(
      desktopAuthState,
      route,
    );
    const syncKey = cloudProviderAuthReconciliationSignature(
      account.accountId,
      reconciliationTargets,
    ) ?? cloudProviderAuthSnapshotRouteSignature(account.accountId, route);
    activeSyncKeyRef.current = syncKey;
    if (!syncKey) return;

    const isCurrent = () => (
      activeAccountIdRef.current === account.accountId
      && activeSyncKeyRef.current === syncKey
    );
    const task = syncGateRef.current?.start(
      account.accountId,
      syncKey,
      () => reconcileCloudProviderAuthSnapshots({
        accountId: account.accountId,
        client,
        route,
        desktopAuthState,
        isCurrent,
      }),
    );
    if (!task) return;

    const scheduleRetry = () => {
      if (!isCurrent() || retryTimerRef.current !== null) return;
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        retrySync();
      }, PROVIDER_AUTH_SYNC_RETRY_MS);
    };
    const clearRetry = () => {
      if (retryTimerRef.current === null) return;
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    };
    if (task.key !== syncKey) {
      void task.promise.then(scheduleRetry, scheduleRetry);
      return;
    }
    void task.promise
      .then((outcome) => {
        if (outcome === 'complete') clearRetry();
        else scheduleRetry();
      })
      .catch((error) => {
        reportWarning(
          '[cloud-provider-auth-sync] publish failed',
          error,
        );
        scheduleRetry();
      });
  }, [
    account,
    client,
    desktopAuthState,
    initialMessagesSettled,
    reportWarning,
    route,
  ]);
}

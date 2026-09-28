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
import type { DesktopAuthSyncIntent } from '@/features/auth/desktopAuthSync';
import type {
  CloudAccount,
  CloudAuthClient,
} from './authClient';
import { createCloudProviderAuthApi } from './providerAuthClient';
import { createProviderAuthPublishGate, type ProviderAuthPublishGate } from './providerAuthPublishGate';
import { publishableAccountLabel } from './routeAccountChoice';
import {
  canonicalCloudProviderId,
  cloudProviderAuthReconciliationTargets,
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
  intent: DesktopAuthSyncIntent;
  isCurrent: () => boolean;
  loadStoredSession?: typeof loadSession;
  buildSnapshotPayload?: typeof buildDesktopCloudProviderAuthSnapshotPayload;
  publishGate?: ProviderAuthPublishGate;
};

export async function reconcileCloudProviderAuthSnapshots({
  accountId,
  client,
  route,
  desktopAuthState,
  intent,
  isCurrent,
  loadStoredSession = loadSession,
  buildSnapshotPayload = buildDesktopCloudProviderAuthSnapshotPayload,
  publishGate = createProviderAuthPublishGate(),
}: ReconcileCloudProviderAuthSnapshotsOptions): Promise<CloudProviderAuthSnapshotSyncOutcome> {
  const session = await loadStoredSession();
  if (
    !session?.token
    || session.accountId !== accountId
    || !isCurrent()
  ) return 'not-ready';
  if ((intent.accountId && intent.accountId !== session.accountId)
    || (intent.deviceId && intent.deviceId !== session.deviceId)) return 'stale';

  const reconciliationTargets = cloudProviderAuthReconciliationTargets(
    desktopAuthState,
    route,
  );
  const provider = canonicalCloudProviderId(intent.providerId);
  const matchingTargets = reconciliationTargets.filter(
    (target) => target.provider === provider,
  );
  const target = matchingTargets.find((candidate) => candidate.configured)
    ?? matchingTargets[0];
  const removalRequested = intent.reason === 'profile-removed'
    || intent.reason === 'provider-logout';
  if (removalRequested) {
    const snapshots = await createCloudProviderAuthApi(client).listProviderAuthSnapshots(session.token);
    const removable = snapshots.filter((snapshot) => {
      if (!isCurrent() || canonicalCloudProviderId(snapshot.provider) !== provider) return false;
      if (intent.reason === 'profile-removed') {
        return Boolean(intent.profileId && snapshot.authChoice === `profile:${intent.profileId}`);
      }
      return snapshot.authChoice.startsWith('profile:')
        || snapshot.authChoice.startsWith('local-active-');
    });
    for (const snapshot of removable) {
      if (!isCurrent()) return 'stale';
      await client.revokeProviderAuthSnapshot(session.token, snapshot.snapshotId);
    }
  }

  if (!target) return removalRequested ? 'complete' : 'not-ready';
  if (!target.configured) {
    return removalRequested && isCurrent() ? 'complete' : 'not-ready';
  }

  const choices = new Set([target.authChoice]);
  for (const localProvider of desktopAuthState?.providers ?? []) {
    if (canonicalCloudProviderId(localProvider.id) !== provider) continue;
    for (const option of localProvider.options) {
      if (option.value.startsWith('profile:')) choices.add(option.value);
    }
  }
  // Only the account the owner just added or reconnected is published as is;
  // every other account is published only when its fingerprint changed.
  const explicitChoice = intent.reason === 'oauth-completed' || intent.reason === 'api-key-saved'
    ? (intent.profileId ? `profile:${intent.profileId}` : target.authChoice)
    : null;
  let published = false;
  for (const authChoice of choices) {
    const built = await buildSnapshotPayload({
      provider: target.provider,
      authChoice,
      model: target.model,
    });
    if (!built) {
      if (authChoice === target.authChoice) return 'not-ready';
      continue;
    }
    const input = { ...built, label: publishableAccountLabel(built.label ?? null) };
    const decision = await publishGate.shouldPublish(session.accountId, input, authChoice === explicitChoice);
    if (!isCurrent()) return 'stale';
    if (decision.publish) {
      await client.publishProviderAuthSnapshot(session.token, input);
      publishGate.record(session.accountId, input, decision.fingerprint);
    }
    published = true;
  }
  if (!published) return 'not-ready';
  return isCurrent() ? 'complete' : 'stale';
}

const PROVIDER_AUTH_SYNC_RETRY_MS = 1_500;

export function useCloudProviderAuthSnapshotSync({
  account,
  client,
  route,
  desktopAuthState,
  intent,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  route: DesktopChatMessageRoute | null | undefined;
  desktopAuthState?: DesktopAuthState | null;
  intent?: DesktopAuthSyncIntent | null;
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
    if (!account || !intent) return;
    if (intent.accountId && intent.accountId !== account.accountId) return;
    const provider = canonicalCloudProviderId(intent.providerId);
    const syncKey = [
      account.accountId,
      intent.revision,
      intent.reason,
      provider ?? '',
      intent.profileId ?? '',
    ].join('|');
    activeSyncKeyRef.current = syncKey;

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
        intent,
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
    intent,
    reportWarning,
    route,
  ]);
}

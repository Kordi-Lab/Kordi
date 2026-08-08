import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  buildDesktopCloudProviderAuthSnapshotPayload,
  restoreDesktopCloudProviderAuth,
} from '@/lib/desktop';
import { requestDesktopAuthRefresh } from '@/features/auth/desktopAuthSync';
import type {
  CloudAccount,
  CloudAuthClient,
} from './authClient';
import type { DesktopAuthState } from '@/kordi-app/types';
import {
  canReconcileCloudProviderAuthManifest,
  cloudProviderAuthSnapshotIdentity,
  cloudProviderAuthSyncTargets,
} from './providerAuthSnapshot';
import {
  loadSession,
} from './session';
import { CLOUD_PROVIDER_AUTH_UPDATED_EVENT } from './cloudSessionAuth';
import {
  CLOUD_PROVIDER_AUTH_SYNC_REQUEST_EVENT,
  type CloudProviderAuthSyncRequestDetail,
} from './cloudProviderAuthSyncRequest';

const PROVIDER_AUTH_PUBLISH_REFRESH_INTERVAL_MS = 5 * 60_000;
const PROVIDER_AUTH_RESTORE_INTERVAL_MS = 15_000;

export function useCloudProviderAuthSnapshotSync({
  account,
  client,
  authState,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  authState?: DesktopAuthState | null;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const publishedCredentialRevisionsRef = useRef<Map<string, string>>(new Map());
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastRestoreWarningRef = useRef<string | null>(null);
  const restoreReadyAccountIdRef = useRef<string | null>(null);
  const latestAuthStateRef = useRef(authState);
  const [restoreStatus, setRestoreStatus] = useState<{
    accountId: string;
    authStateBeforeRefresh?: DesktopAuthState | null;
  } | null>(null);
  const [reconciledState, setReconciledState] = useState<{
    accountId: string;
    authState: DesktopAuthState;
  } | null>(null);
  const [publishRefreshGeneration, setPublishRefreshGeneration] = useState(0);

  const restoreReadyAccountId = restoreStatus
    && restoreStatus.accountId === account?.accountId
    && (
      restoreStatus.authStateBeforeRefresh === undefined
      || restoreStatus.authStateBeforeRefresh !== authState
    )
    ? restoreStatus.accountId
    : null;

  const enqueueSync = useCallback((operation: () => Promise<void>) => {
    const queued = syncQueueRef.current
      .catch(() => undefined)
      .then(operation);
    syncQueueRef.current = queued.catch(() => undefined);
    return queued;
  }, []);

  useEffect(() => {
    latestAuthStateRef.current = authState;
  }, [authState]);

  useEffect(() => {
    publishedCredentialRevisionsRef.current.clear();
    lastRestoreWarningRef.current = null;
    restoreReadyAccountIdRef.current = null;
  }, [account?.accountId]);

  useEffect(() => {
    restoreReadyAccountIdRef.current = restoreReadyAccountId;
  }, [restoreReadyAccountId]);

  useEffect(() => {
    if (!account || typeof window === 'undefined') return;
    let cancelled = false;

    const restore = () => enqueueSync(async () => {
      if (cancelled) return;
      restoreReadyAccountIdRef.current = null;
      try {
        const result = await restoreDesktopCloudProviderAuth(account.accountId);
        if (cancelled) return;
        lastRestoreWarningRef.current = null;
        if (
          result.changed
          && (
            result.restoredProfiles > 0
            || result.removedProfiles > 0
            || result.selectionChanged
          )
        ) {
          setRestoreStatus({
            accountId: account.accountId,
            authStateBeforeRefresh: latestAuthStateRef.current ?? null,
          });
          requestDesktopAuthRefresh('cloud-restored');
        } else {
          restoreReadyAccountIdRef.current = account.accountId;
          setRestoreStatus({ accountId: account.accountId });
        }
      } catch (error) {
        if (cancelled) return;
        setRestoreStatus(null);
        const warningKey = error instanceof Error ? error.message : String(error);
        if (lastRestoreWarningRef.current !== warningKey) {
          lastRestoreWarningRef.current = warningKey;
          reportWarning(`[cloud-provider-auth-sync] restore failed: ${warningKey}`, error);
        }
        throw error;
      }
    });

    const restoreInBackground = () => {
      void restore().catch(() => undefined);
    };

    const handleManualSyncRequest = (event: Event) => {
      const detail = (event as CustomEvent<CloudProviderAuthSyncRequestDetail>).detail;
      if (!detail || detail.handled) return;
      detail.handled = true;
      void restore().then(detail.resolve, detail.reject);
    };

    restoreInBackground();
    const intervalId = window.setInterval(restoreInBackground, PROVIDER_AUTH_RESTORE_INTERVAL_MS);
    window.addEventListener('focus', restoreInBackground);
    window.addEventListener(CLOUD_PROVIDER_AUTH_UPDATED_EVENT, restoreInBackground);
    window.addEventListener(CLOUD_PROVIDER_AUTH_SYNC_REQUEST_EVENT, handleManualSyncRequest);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', restoreInBackground);
      window.removeEventListener(CLOUD_PROVIDER_AUTH_UPDATED_EVENT, restoreInBackground);
      window.removeEventListener(CLOUD_PROVIDER_AUTH_SYNC_REQUEST_EVENT, handleManualSyncRequest);
    };
  }, [account, enqueueSync, reportWarning]);

  useEffect(() => {
    if (!account) return;
    const intervalId = window.setInterval(() => {
      publishedCredentialRevisionsRef.current.clear();
      setPublishRefreshGeneration((current) => current + 1);
    }, PROVIDER_AUTH_PUBLISH_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [account]);

  useEffect(() => {
    if (
      !account
      || !authState
      || !canReconcileCloudProviderAuthManifest(account.accountId, restoreReadyAccountId)
    ) return;
    const targets = cloudProviderAuthSyncTargets(authState);
    let cancelled = false;

    void enqueueSync(async () => {
      if (!canReconcileCloudProviderAuthManifest(
        account.accountId,
        restoreReadyAccountIdRef.current,
      )) return;
      const session = await loadSession();
      if (!session?.token || cancelled) return;

      const materials = [];
      for (const target of targets) {
        if (cancelled) return;
        const material = await buildDesktopCloudProviderAuthSnapshotPayload({
          accountId: account.accountId,
          provider: target.provider,
          authChoice: target.authChoice,
          model: target.model,
          active: target.active,
        });
        if (!material) {
          throw new Error(`Could not read saved authentication for ${target.provider} ${target.authChoice}`);
        }
        materials.push(material);
      }

      for (const material of materials) {
        if (cancelled) return;
        const identity = cloudProviderAuthSnapshotIdentity(material.provider, material.authChoice);
        if (publishedCredentialRevisionsRef.current.get(identity) === material.credentialRevision) {
          continue;
        }
        const { credentialRevision, ...input } = material;
        await client.publishProviderAuthSnapshot(session.token, input);
        publishedCredentialRevisionsRef.current.set(identity, credentialRevision);
      }

      if (cancelled) return;
      const desired = new Set(materials.map((material) => (
        cloudProviderAuthSnapshotIdentity(material.provider, material.authChoice)
      )));
      const manifest = await client.providerAuthSnapshotManifest(session.token);
      for (const snapshot of manifest.snapshots) {
        if (cancelled) return;
        const identity = cloudProviderAuthSnapshotIdentity(snapshot.provider, snapshot.authChoice);
        if (desired.has(identity)) continue;
        await client.revokeProviderAuthSnapshot(session.token, snapshot.snapshotId);
        publishedCredentialRevisionsRef.current.delete(identity);
      }
      if (!cancelled) {
        setReconciledState({
          accountId: account.accountId,
          authState,
        });
      }
    }).catch((error) => {
      if (!cancelled) {
        reportWarning('[cloud-provider-auth-sync] reconcile failed', error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    account,
    authState,
    client,
    enqueueSync,
    publishRefreshGeneration,
    reportWarning,
    restoreReadyAccountId,
  ]);

  const reconciledAuthState = reconciledState
    && reconciledState.accountId === account?.accountId
    ? reconciledState.authState
    : null;

  return {
    restoreReadyAccountId,
    reconciledAuthState,
  };
}

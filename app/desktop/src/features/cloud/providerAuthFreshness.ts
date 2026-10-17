import { useEffect, useRef } from 'react';
import {
  buildDesktopCloudProviderAuthSnapshotPayload,
  isNativeDesktopShell,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import type { DesktopAuthState } from '@/kordi-app/types';
import type { CloudAccount, CloudAuthClient } from './authClient';
import { createCloudProviderAuthApi } from './providerAuthClient';
import { createProviderAuthPublishGate, type ProviderAuthPublishGate } from './providerAuthPublishGate';
import { canonicalCloudProviderId, cloudProviderAuthReconciliationTargets } from './providerAuthSnapshot';
import { publishableAccountLabel } from './routeAccountChoice';
import { loadSession } from './session';

// Keeps the Cloud copies of this Mac's provider accounts current (issue 1804).
// A sign-in copy holds only an access token; building it refreshes the token
// on this Mac when it is about to expire, and a changed token is uploaded
// again. Refresh tokens never leave this Mac. An account this Mac uploaded
// that is gone from Cloud was removed on purpose and is never re-added, and
// an account Cloud already holds from another device is left to that device.

export const PROVIDER_AUTH_FRESHNESS_INTERVAL_MS = 10 * 60 * 1000;

type RefreshCloudProviderAuthCopiesOptions = {
  accountId: string;
  client: CloudAuthClient;
  route: DesktopChatMessageRoute | null | undefined;
  desktopAuthState: DesktopAuthState | null | undefined;
  isCurrent: () => boolean;
  loadStoredSession?: typeof loadSession;
  buildSnapshotPayload?: typeof buildDesktopCloudProviderAuthSnapshotPayload;
  publishGate?: ProviderAuthPublishGate;
};

/** Uploads the accounts whose Cloud copy is missing or stale; returns how many it uploaded. */
export async function refreshCloudProviderAuthCopies({
  accountId,
  client,
  route,
  desktopAuthState,
  isCurrent,
  loadStoredSession = loadSession,
  buildSnapshotPayload = buildDesktopCloudProviderAuthSnapshotPayload,
  publishGate = createProviderAuthPublishGate(),
}: RefreshCloudProviderAuthCopiesOptions): Promise<number> {
  const targets = cloudProviderAuthReconciliationTargets(desktopAuthState, route)
    .filter((target) => target.configured);
  if (targets.length === 0) return 0;
  const session = await loadStoredSession();
  if (!session?.token || session.accountId !== accountId || !isCurrent()) return 0;
  const api = createCloudProviderAuthApi(client);
  const keyOf = (provider: string, authChoice: string) => `${canonicalCloudProviderId(provider)}\u0000${authChoice}`;
  const [mine, all] = await Promise.all([
    api.listProviderAuthSnapshots(session.token, true),
    api.listProviderAuthSnapshots(session.token, false),
  ]);
  const liveHere = new Set(mine.map((snapshot) => keyOf(snapshot.provider, snapshot.authChoice)));
  const liveAnywhere = new Set(all.map((snapshot) => keyOf(snapshot.provider, snapshot.authChoice)));
  let uploaded = 0;
  for (const target of targets) {
    const choices = new Set(target.authChoice ? [target.authChoice] : []);
    for (const localProvider of desktopAuthState?.providers ?? []) {
      if (canonicalCloudProviderId(localProvider.id) !== target.provider) continue;
      for (const option of localProvider.options) {
        if (option.value.startsWith('profile:')) choices.add(option.value);
      }
    }
    for (const authChoice of choices) {
      let built: Awaited<ReturnType<typeof buildSnapshotPayload>>;
      try {
        built = await buildSnapshotPayload({ provider: target.provider, authChoice, model: target.model });
      } catch {
        continue; // This Mac cannot sign this account in right now.
      }
      if (!built || !isCurrent()) continue;
      const input = { ...built, label: publishableAccountLabel(built.label ?? null) };
      const key = keyOf(input.provider, input.authChoice);
      let fingerprint: string;
      if (liveHere.has(key)) {
        const decision = await publishGate.shouldPublish(session.accountId, input, false);
        if (!decision.publish) continue;
        fingerprint = decision.fingerprint;
      } else if (!liveAnywhere.has(key) && !publishGate.hasPublished(session.accountId, input)) {
        fingerprint = (await publishGate.shouldPublish(session.accountId, input, true)).fingerprint;
      } else {
        continue;
      }
      if (!isCurrent()) return uploaded;
      await client.publishProviderAuthSnapshot(session.token, input);
      publishGate.record(session.accountId, input, fingerprint);
      uploaded += 1;
    }
  }
  return uploaded;
}

/** Runs the refresh when Cloud signs in, when the window gains focus, and every ten minutes. */
export function useCloudProviderAuthFreshness({
  account,
  client,
  route,
  desktopAuthState,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  route: DesktopChatMessageRoute | null | undefined;
  desktopAuthState?: DesktopAuthState | null;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const latest = useRef({ client, route, desktopAuthState, reportWarning });
  useEffect(() => {
    latest.current = { client, route, desktopAuthState, reportWarning };
  }, [client, route, desktopAuthState, reportWarning]);
  const accountId = account?.accountId ?? null;
  const authReady = desktopAuthState != null;
  useEffect(() => {
    if (!accountId || !authReady || !isNativeDesktopShell()) return;
    let active = true;
    let running = false;
    const run = () => {
      if (running) return;
      running = true;
      const current = latest.current;
      void refreshCloudProviderAuthCopies({
        accountId,
        client: current.client,
        route: current.route,
        desktopAuthState: current.desktopAuthState,
        isCurrent: () => active,
      })
        .catch((error) => current.reportWarning('[cloud-provider-auth-freshness] refresh failed', error))
        .finally(() => { running = false; });
    };
    run();
    const timer = window.setInterval(run, PROVIDER_AUTH_FRESHNESS_INTERVAL_MS);
    window.addEventListener('focus', run);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', run);
    };
  }, [accountId, authReady]);
}

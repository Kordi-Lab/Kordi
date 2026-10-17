import type { CloudAuthClient } from './authClient';
import { createCloudProviderAuthApi } from './providerAuthClient';
import type { ProviderAuthPublishGate, PublishableSnapshot } from './providerAuthPublishGate';
import { canonicalCloudProviderId } from './providerAuthSnapshot';

// Which of this Mac's accounts a background refresh may upload (issue 1804).
// A refresh keeps this Mac's Cloud copies current, but never re-adds a copy
// that was removed on another device and never replaces a copy that another
// device uploaded.

export type CloudCopies = {
  mayRefresh(accountId: string, snapshot: Pick<PublishableSnapshot, 'provider' | 'authChoice'>, gate: ProviderAuthPublishGate): boolean;
};

export async function liveCloudCopies(client: CloudAuthClient, token: string): Promise<CloudCopies> {
  const api = createCloudProviderAuthApi(client);
  const [here, anywhere] = await Promise.all([
    api.listProviderAuthSnapshots(token, true),
    api.listProviderAuthSnapshots(token, false),
  ]);
  const keyOf = (snapshot: Pick<PublishableSnapshot, 'provider' | 'authChoice'>) => `${canonicalCloudProviderId(snapshot.provider)}\u0000${snapshot.authChoice}`;
  const liveHere = new Set(here.map(keyOf));
  const liveAnywhere = new Set(anywhere.map(keyOf));
  return {
    mayRefresh(accountId, snapshot, gate) {
      const key = keyOf(snapshot);
      // Live from this Mac: keep it current. Never uploaded from this Mac
      // and not in Cloud at all: upload it once.
      return liveHere.has(key) || (!liveAnywhere.has(key) && !gate.hasPublished(accountId, snapshot));
    },
  };
}

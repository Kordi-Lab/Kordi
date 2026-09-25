import { publishableAccountLabel } from './routeAccountChoice';

// Desktop accounts are published to the hosted store only when they change or
// when the owner explicitly adds or reconnects one. Re-publishing an unchanged
// account on every sync would overwrite what the server holds for it.

type FingerprintStore = Pick<Storage, 'getItem' | 'setItem'>;

export type PublishableSnapshot = {
  provider: string;
  authChoice: string;
  label?: string | null;
  payload: Record<string, unknown>;
};

const STORAGE_KEY = 'kordi.providerAuthPublished.v1';

function defaultStorage(): FingerprintStore | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function credentialOf(payload: Record<string, unknown>) {
  for (const key of ['accessToken', 'apiKey']) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

/** SHA-256 over provider, choice, label and credential; only the hash is stored. */
export async function providerAuthSnapshotFingerprint(snapshot: PublishableSnapshot) {
  const material = JSON.stringify([
    snapshot.provider,
    snapshot.authChoice,
    publishableAccountLabel(snapshot.label ?? '') ?? '',
    credentialOf(snapshot.payload),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type ProviderAuthPublishGate = {
  /** Whether to publish; unchanged snapshots are skipped unless the owner acted explicitly. */
  shouldPublish(accountId: string, snapshot: PublishableSnapshot, explicit: boolean): Promise<{ publish: boolean; fingerprint: string }>;
  record(accountId: string, snapshot: PublishableSnapshot, fingerprint: string): void;
};

export function createProviderAuthPublishGate(storage: FingerprintStore | null = defaultStorage()): ProviderAuthPublishGate {
  const keyFor = (accountId: string, snapshot: PublishableSnapshot) => `${accountId}\u0000${snapshot.provider}\u0000${snapshot.authChoice}`;
  const read = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}') as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  };
  return {
    async shouldPublish(accountId, snapshot, explicit) {
      const fingerprint = await providerAuthSnapshotFingerprint(snapshot);
      // Without persistent storage there is nothing to compare against.
      if (!storage || explicit) return { publish: true, fingerprint };
      return { publish: read()[keyFor(accountId, snapshot)] !== fingerprint, fingerprint };
    },
    record(accountId, snapshot, fingerprint) {
      if (!storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ ...read(), [keyFor(accountId, snapshot)]: fingerprint }));
      } catch {
        // A full or blocked store only means the next sync publishes again.
      }
    },
  };
}

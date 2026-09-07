
export const CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX =
  'kordi.cloud.selfAgentSync.chat:';

export const PREVIOUS_CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX =
  'kordi.cloud.selfAgentSync.v2:';

export const CLOUD_SELF_AGENT_FORWARD_BASELINE_PREFIX =
  'kordi.cloud.selfAgentForwardBaseline.v1:';

export const CLOUD_SELF_AGENT_FORWARD_CUTOFF_PREFIX =
  'kordi.cloud.selfAgentForwardCutoff.v1:';

export type CloudSelfAgentSyncLedgerEntry = {
  cloudMessageId: string | null;
  syncedAtMs: number;
  skippedLocalBackfill?: boolean;
};

export type CloudSelfAgentSyncLedger =
  Record<string, CloudSelfAgentSyncLedgerEntry>;

export function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

export function selfAgentSyncLedgerKey(accountId: string): string {
  return `${CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX}${accountId}`;
}

export function selfAgentForwardBaselineKey(accountId: string): string {
  return `${CLOUD_SELF_AGENT_FORWARD_BASELINE_PREFIX}${accountId}`;
}

export function selfAgentForwardCutoffKey(accountId: string): string {
  return `${CLOUD_SELF_AGENT_FORWARD_CUTOFF_PREFIX}${accountId}`;
}

export function loadCloudSelfAgentForwardBaseline(
  accountId: string,
): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(
    selfAgentForwardBaselineKey(accountId),
  ) === '1';
}

export function saveCloudSelfAgentForwardBaseline(accountId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      selfAgentForwardBaselineKey(accountId),
      '1',
    );
  } catch {
    // Best effort. If persistence fails, this device may try again later.
  }
}

export function loadCloudSelfAgentForwardCutoff(
  accountId: string,
): number | null {
  if (typeof window === 'undefined') return null;
  const parsed = Number(window.localStorage.getItem(
    selfAgentForwardCutoffKey(accountId),
  ));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function saveCloudSelfAgentForwardCutoff(
  accountId: string,
  cutoffMs: number = Date.now(),
): number {
  const normalizedCutoff = Number.isFinite(cutoffMs) && cutoffMs > 0
    ? Math.floor(cutoffMs)
    : Date.now();
  if (typeof window === 'undefined') return normalizedCutoff;
  try {
    window.localStorage.setItem(
      selfAgentForwardCutoffKey(accountId),
      String(normalizedCutoff),
    );
  } catch {
    // Best effort. The caller still uses this boundary for the current run.
  }
  return normalizedCutoff;
}

export function loadCloudSelfAgentSyncLedger(
  accountId: string,
): CloudSelfAgentSyncLedger {
  if (typeof window === 'undefined') return {};
  try {
    const key = selfAgentSyncLedgerKey(accountId);
    const previousKey = `${PREVIOUS_CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX}${accountId}`;
    const raw = window.localStorage.getItem(key)
      ?? window.localStorage.getItem(previousKey);
    if (raw && window.localStorage.getItem(key) === null) {
      window.localStorage.setItem(key, raw);
      window.localStorage.removeItem(previousKey);
    }
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
    ) return {};
    const ledger: CloudSelfAgentSyncLedger = {};
    for (const [localMessageId, value] of Object.entries(parsed)) {
      if (
        !value
        || typeof value !== 'object'
        || Array.isArray(value)
      ) continue;
      const record = value as Record<string, unknown>;
      const cloudMessageId = cleanText(
        typeof record.cloudMessageId === 'string'
          ? record.cloudMessageId
          : null,
      );
      const syncedAtMs = record.syncedAtMs;
      const skippedLocalBackfill =
        record.skippedLocalBackfill === true;
      if (
        !localMessageId.trim()
        || typeof syncedAtMs !== 'number'
        || !Number.isFinite(syncedAtMs)
      ) continue;
      if (!cloudMessageId && !skippedLocalBackfill) continue;
      ledger[localMessageId] = {
        cloudMessageId: cloudMessageId || null,
        syncedAtMs,
        skippedLocalBackfill: skippedLocalBackfill || undefined,
      };
    }
    return ledger;
  } catch {
    return {};
  }
}

export function saveCloudSelfAgentSyncLedger(
  accountId: string,
  ledger: CloudSelfAgentSyncLedger,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      selfAgentSyncLedgerKey(accountId),
      JSON.stringify(ledger),
    );
    window.localStorage.removeItem(
      `${PREVIOUS_CLOUD_SELF_AGENT_SYNC_LEDGER_PREFIX}${accountId}`,
    );
  } catch {
    // Best effort. A failed ledger write may cause a future duplicate sync,
    // but should not block local chat or Cloud refresh.
  }
}

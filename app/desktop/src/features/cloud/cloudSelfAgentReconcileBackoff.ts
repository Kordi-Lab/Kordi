import type { CanonicalSessionState } from '@/kordi-app/types';
import { planCloudSelfAgentSync } from './cloudSelfAgentForwardSync';
import { loadCloudSelfAgentForwardCutoff, loadCloudSelfAgentSyncLedger } from './cloudSelfAgentSyncLedger';

export const CLOUD_SELF_AGENT_RECONCILE_RETRY_MS = 30_000;
/** Repeated failures double the wait up to this cap; one run re-reads every agent chat's history. */
export const CLOUD_SELF_AGENT_RECONCILE_MAX_RETRY_MS = 10 * 60_000;

/** The wait after `consecutiveFailures` failed runs in a row (the first waits the base window). */
export function cloudSelfAgentReconcileRetryMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(10, consecutiveFailures - 1));
  return Math.min(CLOUD_SELF_AGENT_RECONCILE_MAX_RETRY_MS, CLOUD_SELF_AGENT_RECONCILE_RETRY_MS * 2 ** exponent);
}

export type CloudSelfAgentReconcileFailure = {
  accountId: string;
  failedAtMs: number;
  /** The local messages still waiting to forward when the run failed. */
  pendingMessageIds: ReadonlySet<string>;
  /** Failed runs in a row, including this one. */
  consecutiveFailures?: number;
};

/** The local messages this Mac has not forwarded to Kordi Cloud yet. */
export function pendingCloudSelfAgentForwardIds(accountId: string, state: CanonicalSessionState | null): Set<string> {
  if (!state) return new Set();
  const operations = planCloudSelfAgentSync(state, loadCloudSelfAgentSyncLedger(accountId), {
    createdAfterMs: loadCloudSelfAgentForwardCutoff(accountId),
  });
  return new Set(operations.map((operation) => operation.localMessageId));
}

/**
 * A failed run waits out its retry window before it runs again, unless a
 * message was sent since: that message forwards at once instead of waiting
 * behind the failure (issue #2026).
 */
export function cloudSelfAgentReconcileBackoffHolds(
  failure: CloudSelfAgentReconcileFailure | null,
  accountId: string,
  nowMs: number,
  pendingMessageIds: ReadonlySet<string>,
): boolean {
  if (!failure || failure.accountId !== accountId || nowMs - failure.failedAtMs >= cloudSelfAgentReconcileRetryMs(failure.consecutiveFailures ?? 1)) return false;
  for (const id of pendingMessageIds) if (!failure.pendingMessageIds.has(id)) return false;
  return true;
}

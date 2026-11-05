import { formatUtcClock, type CloudOrganizationRole, type UsageLimitId, type UsageSnapshot } from './usageClient';

const LABELS: Record<UsageLimitId, string> = {
  'pool.runs': 'Runs',
  'pool.spend': 'Spend',
  'account.grounding_runs': 'Grounding',
  'conversation.system_agent_runs': 'System agent per chat',
  'pool.stopped': 'System agent',
};

export function usageLabel(snapshot: UsageSnapshot): string {
  return LABELS[snapshot.limitId] ?? snapshot.limitId;
}

/** "7 of 10" (spend in currency units) when the server sends amounts, otherwise "70%". */
export function usageValueLabel(snapshot: UsageSnapshot): string {
  if (typeof snapshot.used === 'number' && typeof snapshot.limit === 'number') {
    if (snapshot.limitId === 'pool.spend') {
      return `${(snapshot.used / 1_000_000).toFixed(2)} of ${(snapshot.limit / 1_000_000).toFixed(2)}`;
    }
    return `${snapshot.used} of ${snapshot.limit}`;
  }
  return `${snapshot.usedPercent}%`;
}

export type UsageBarTone = 'accent' | 'amber' | 'red';

export function usageBarTone(snapshot: UsageSnapshot): UsageBarTone {
  if (snapshot.reached !== 'none' || snapshot.usedPercent >= 90) return 'red';
  return snapshot.usedPercent >= 75 ? 'amber' : 'accent';
}

/** The muted line under a row, worded for the viewer's role. */
export function usageStatusLine(snapshot: UsageSnapshot, role: CloudOrganizationRole | null | undefined): string {
  const resets = formatUtcClock(snapshot.resetsAt);
  if (snapshot.reached === 'none') return `Resets at ${resets} UTC`;
  if (snapshot.reached === 'stopped') return 'Paused by an owner.';
  const line = snapshot.pausedSince
    ? `Paused since ${formatUtcClock(snapshot.pausedSince)}, resets ${resets} UTC.`
    : `Limit reached. Resets at ${resets} UTC.`;
  return role === 'owner' || role === 'admin' ? line : `${line} Ask an owner to raise it.`;
}

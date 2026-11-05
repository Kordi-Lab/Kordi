import type { MessageUsageLimit } from '@/kordi-app/types/message';

import { formatUtcClock, type CloudOrganizationRole } from './usageClient';

const SYSTEM_NOTICE_KIND = 'system-notice';
const REACHED = new Set<MessageUsageLimit['reached']>(['daily_limit', 'spend_limit', 'stopped']);

/** Reads `usageLimit` from a system notice's content; malformed values return null. */
export function parseUsageLimit(value: unknown): MessageUsageLimit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const reached = record.reached;
  if (typeof reached !== 'string' || !REACHED.has(reached as MessageUsageLimit['reached'])) return null;
  const resetsAt = typeof record.resetsAt === 'string' && !Number.isNaN(Date.parse(record.resetsAt)) ? record.resetsAt : null;
  const organizationId = typeof record.organizationId === 'string' && record.organizationId.trim() ? record.organizationId : null;
  return { reached: reached as MessageUsageLimit['reached'], resetsAt, organizationId };
}

/** Spread into a mapped message: only system notices carry a usage limit. */
export function usageLimitField(messageKind: string | null | undefined, content: Record<string, unknown>): { usageLimit?: MessageUsageLimit } {
  if (messageKind?.trim() !== SYSTEM_NOTICE_KIND) return {};
  const usageLimit = parseUsageLimit(content.usageLimit);
  return usageLimit ? { usageLimit } : {};
}

export type UsageLimitNoticeCopy = { text: string; showUsageLink: boolean };

/** Role-aware chat copy. `role` undefined means the viewer's organizations are still loading. */
export function usageLimitNoticeCopy(limit: MessageUsageLimit, role: CloudOrganizationRole | null | undefined): UsageLimitNoticeCopy {
  if (limit.reached === 'stopped') return { text: 'Paused by an owner.', showUsageLink: false };
  const base = `Daily limit reached. Resets at ${formatUtcClock(limit.resetsAt)} UTC.`;
  if (role === undefined) return { text: base, showUsageLink: false };
  if (limit.organizationId && (role === 'owner' || role === 'admin')) return { text: base, showUsageLink: true };
  return { text: `${base} Ask an owner to raise it.`, showUsageLink: false };
}

export const USAGE_SETTINGS_LINK_EVENT = 'kordi:open-usage-settings';

/** Asks the app shell to open account settings on the Usage tab. */
export function openUsageSettings(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(USAGE_SETTINGS_LINK_EVENT));
}

import type { CloudGroupMemberJoin, CloudGroupMemberLeave } from './cloudGroupMessages';
import { integerMilliseconds } from './cloudGroupDecoding';
import { isCloudAccountId } from './cloudTransportGuards';
const CLOUD_GROUP_MEMBER_JOIN_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const cleanText = (value?: string | null) => value?.trim() ?? '';
function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function cloudGroupMemberJoins(value: unknown): CloudGroupMemberJoin[] {
  if (!Array.isArray(value)) return [];
  const seenEventIds = new Set<string>();
  const joins: CloudGroupMemberJoin[] = [];
  value.forEach((candidate) => {
    const record = objectRecord(candidate);
    const eventId = cleanText(typeof record.eventId === 'string' ? record.eventId : null);
    const accountId = cleanText(typeof record.accountId === 'string' ? record.accountId : null);
    const displayName = cleanText(typeof record.displayName === 'string' ? record.displayName : null);
    const createdAtMs = integerMilliseconds(record.createdAtMs);
    if (!CLOUD_GROUP_MEMBER_JOIN_EVENT_ID_PATTERN.test(eventId)
      || !isCloudAccountId(accountId)
      || createdAtMs === null
      || seenEventIds.has(eventId)) return;
    seenEventIds.add(eventId);
    joins.push({
      eventId,
      accountId,
      displayName: displayName || accountId,
      createdAtMs,
    });
  });
  return joins;
}

export function cloudGroupMemberLeaves(value: unknown): CloudGroupMemberLeave[] {
  if (!Array.isArray(value)) return [];
  const seenEventIds = new Set<string>();
  const leaves: CloudGroupMemberLeave[] = [];
  value.forEach((candidate) => {
    const record = objectRecord(candidate);
    const eventId = cleanText(typeof record.eventId === 'string' ? record.eventId : null);
    const accountId = cleanText(typeof record.accountId === 'string' ? record.accountId : null);
    const createdAtMs = integerMilliseconds(record.createdAtMs);
    if (!CLOUD_GROUP_MEMBER_JOIN_EVENT_ID_PATTERN.test(eventId)
      || !isCloudAccountId(accountId)
      || createdAtMs === null
      || seenEventIds.has(eventId)) return;
    seenEventIds.add(eventId);
    leaves.push({ eventId, accountId, createdAtMs });
  });
  return leaves;
}

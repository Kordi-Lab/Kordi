// The team organization a local group or AI session was created in. It is
// recorded when the session is created on this Mac, so a later first sync
// creates the conversation there even after the selection changed. Sessions
// with no record (older ones, recovered or received ones) stay personal.
import { defaultStorage, getOrganizationState, organizationIdForNewContent, type OrganizationStorage } from './organizationStore';

/** Oldest records are dropped beyond this; a session normally syncs within seconds. */
const MAX_RECORDED_SESSIONS = 500;

export function sessionOrganizationKey(accountId: string): string {
  return `kordi.organization.sessions.${accountId.trim()}`;
}

function readRecords(accountId: string, storage: OrganizationStorage | null): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(sessionOrganizationKey(accountId)) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string' && entry[1].length > 0
    )));
  } catch {
    return {};
  }
}

function writeRecords(accountId: string, records: Record<string, string>, storage: OrganizationStorage | null): void {
  try {
    const entries = Object.entries(records).slice(-MAX_RECORDED_SESSIONS);
    storage?.setItem(sessionOrganizationKey(accountId), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Without storage the session stays personal.
  }
}

/** Records the selected team organization for a session created now; a personal selection records nothing. */
export function rememberSessionOrganization(
  sessionId: string | null | undefined,
  accountId: string | null | undefined = getOrganizationState().accountId,
  storage: OrganizationStorage | null = defaultStorage(),
): void {
  const session = sessionId?.trim();
  const account = accountId?.trim();
  const organizationId = account ? organizationIdForNewContent(account) : null;
  if (!session || !account || !organizationId) return;
  const records = readRecords(account, storage);
  delete records[session];
  writeRecords(account, { ...records, [session]: organizationId }, storage);
}

/** The organization recorded for a session, or null (personal). */
export function recordedSessionOrganizationId(
  accountId: string,
  sessionId: string,
  storage: OrganizationStorage | null = defaultStorage(),
): string | null {
  const account = accountId.trim();
  return account ? readRecords(account, storage)[sessionId.trim()] ?? null : null;
}

export function forgetSessionOrganization(
  accountId: string,
  sessionId: string,
  storage: OrganizationStorage | null = defaultStorage(),
): void {
  const account = accountId.trim();
  if (!account) return;
  const records = readRecords(account, storage);
  if (!(sessionId.trim() in records)) return;
  delete records[sessionId.trim()];
  writeRecords(account, records, storage);
}

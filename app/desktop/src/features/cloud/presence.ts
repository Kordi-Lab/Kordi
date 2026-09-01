export type CloudPresenceStatus = 'online' | 'offline';

export type CloudPresenceAccount = {
  accountId: string;
  status: CloudPresenceStatus;
  updatedAt: string;
  lastSeenAt: string | null;
  desktopOnline?: boolean;
  desktopLastSeenAt?: string | null;
};

export type CloudPresenceContactsResponse = {
  accounts: CloudPresenceAccount[];
};

export type CloudPresenceStore = Record<string, CloudPresenceAccount>;

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const presenceFormatters = new Map<string, Intl.DateTimeFormat>();

function presenceFormatter(
  kind: 'time' | 'date' | 'date-year',
  locales?: Intl.LocalesArgument,
  timeZone?: string,
) {
  const key = `${kind}|${String(locales ?? '')}|${timeZone ?? ''}`;
  const existing = presenceFormatters.get(key);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat(locales, {
    ...(kind === 'time'
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric', ...(kind === 'date-year' ? { year: 'numeric' } : {}) }),
    ...(timeZone ? { timeZone } : {}),
  });
  presenceFormatters.set(key, formatter);
  return formatter;
}

function calendarDay(value: Date, timeZone?: string) {
  const [year, month, day] = formatDesktopDate(value, { timeZone }).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function contactPresenceLabel(
  presence: CloudPresenceAccount | null,
  options: { now?: Date | number; locales?: Intl.LocalesArgument; timeZone?: string } = {},
) {
  if (presence?.status === 'online') return 'online';
  const timestampMs = Date.parse(presence?.lastSeenAt ?? '');
  if (!Number.isFinite(timestampMs)) return 'last seen recently';
  const date = new Date(timestampMs);
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const time = presenceFormatter('time', options.locales, options.timeZone).format(date);
  const elapsedMs = now.getTime() - timestampMs;
  const dayDifference = calendarDay(now, options.timeZone) - calendarDay(date, options.timeZone);
  if (dayDifference === 0) {
    return elapsedMs >= -60_000 && elapsedMs < 60_000
      ? 'last seen just now'
      : `last seen today at ${time}`;
  }
  if (dayDifference === 1) return `last seen yesterday at ${time}`;
  const sameYear = formatDesktopDate(date, { timeZone: options.timeZone }).slice(0, 4)
    === formatDesktopDate(now, { timeZone: options.timeZone }).slice(0, 4);
  const calendarDate = presenceFormatter(
    sameYear ? 'date' : 'date-year',
    options.locales,
    options.timeZone,
  ).format(date);
  return `last seen ${calendarDate} at ${time}`;
}

export function agentRuntimePresence(
  presence: CloudPresenceAccount | null | undefined,
): CloudPresenceAccount | null | undefined {
  if (!presence) return presence;
  const desktopOnline = presence.desktopOnline === true;
  return {
    ...presence,
    status: desktopOnline ? 'online' : 'offline',
    lastSeenAt: desktopOnline ? null : presence.desktopLastSeenAt ?? null,
  };
}

export function normalizePresenceStatus(value: unknown): CloudPresenceStatus {
  return cleanText(value).toLowerCase() === 'online' ? 'online' : 'offline';
}

export function applyPresenceSnapshot(current: CloudPresenceStore, response: CloudPresenceContactsResponse): CloudPresenceStore {
  let next = current;
  for (const account of response.accounts) {
    const accountId = cleanText(account.accountId);
    if (!accountId) continue;
    const previous = current[accountId];
    const normalized = {
      accountId,
      status: normalizePresenceStatus(account.status),
      updatedAt: cleanText(account.updatedAt)
        || previous?.updatedAt
        || new Date().toISOString(),
      lastSeenAt: cleanText(account.lastSeenAt) || null,
      desktopOnline: typeof account.desktopOnline === 'boolean'
        ? account.desktopOnline
        : previous?.desktopOnline,
      desktopLastSeenAt: account.desktopLastSeenAt === undefined
        ? previous?.desktopLastSeenAt
        : cleanText(account.desktopLastSeenAt) || null,
    };
    // Heartbeats are not visible changes. Keep the object unless either
    // availability status changes or an offline last-seen value moves.
    if (previous?.status === normalized.status
      && previous.desktopOnline === normalized.desktopOnline
      && (normalized.status === 'online' || previous.lastSeenAt === normalized.lastSeenAt)
      && (normalized.desktopOnline || previous.desktopLastSeenAt === normalized.desktopLastSeenAt)) continue;
    if (next === current) next = { ...current };
    next[accountId] = normalized;
  }
  return next;
}

export function mergePresenceEvent(current: CloudPresenceStore, event: CloudPresenceAccount): CloudPresenceStore {
  const accountId = cleanText(event.accountId);
  if (!accountId) return current;
  const previous = current[accountId];
  const status = normalizePresenceStatus(event.status);
  const desktopOnline = typeof event.desktopOnline === 'boolean'
    ? event.desktopOnline
    : previous?.desktopOnline;
  const normalized = {
    accountId,
    status,
    updatedAt: cleanText(event.updatedAt)
      || previous?.updatedAt
      || new Date().toISOString(),
    lastSeenAt: status === 'online'
      ? null
      : cleanText(event.lastSeenAt) || previous?.lastSeenAt || null,
    desktopOnline,
    desktopLastSeenAt: desktopOnline
      ? null
      : event.desktopLastSeenAt === undefined
        ? previous?.desktopLastSeenAt
        : cleanText(event.desktopLastSeenAt) || null,
  };
  if (previous?.status === normalized.status
    && previous.desktopOnline === normalized.desktopOnline
    && (normalized.status === 'online' || previous.lastSeenAt === normalized.lastSeenAt)
    && (normalized.desktopOnline || previous.desktopLastSeenAt === normalized.desktopLastSeenAt)) return current;
  return {
    ...current,
    [accountId]: normalized,
  };
}

export function presenceStatusForAccount(store: CloudPresenceStore, accountId?: string | null): CloudPresenceStatus {
  const id = cleanText(accountId);
  if (!id) return 'offline';
  return store[id]?.status ?? 'offline';
}

export function shouldRefreshPresenceForWsSubject(subject: string): boolean {
  return subject.startsWith('kordi.events.presence.account.');
}

export function cloudPresenceChangedFromWsPayload(payload: unknown): CloudPresenceAccount | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const accountId = cleanText(record.account_id ?? record.accountId);
  if (!accountId) return null;
  const desktopOnline = 'desktop_online' in record
    ? record.desktop_online
    : record.desktopOnline;
  const desktopLastSeenAt = 'desktop_last_seen_at' in record
    ? record.desktop_last_seen_at
    : record.desktopLastSeenAt;
  return {
    accountId,
    status: normalizePresenceStatus(record.status),
    updatedAt: cleanText(record.occurred_at ?? record.updatedAt) || new Date().toISOString(),
    lastSeenAt: cleanText(record.last_seen_at ?? record.lastSeenAt) || null,
    desktopOnline: typeof desktopOnline === 'boolean' ? desktopOnline : undefined,
    desktopLastSeenAt: desktopLastSeenAt === undefined
      ? undefined
      : cleanText(desktopLastSeenAt) || null,
  };
}
import { formatDesktopDate } from '@/lib/time';

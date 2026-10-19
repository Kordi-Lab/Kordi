import { formatDesktopClockTime, formatDesktopDate } from '@/lib/time';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Under this age a last-seen time reads as "N hours ago"; older ones name the clock time. */
const RELATIVE_HOURS_LIMIT_MS = 6 * HOUR_MS;

const calendarDateFormatters = new Map<string, Intl.DateTimeFormat>();

function calendarDateLabel(date: Date, withYear: boolean, timeZone?: string) {
  const key = `${withYear}|${timeZone ?? ''}`;
  let formatter = calendarDateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      ...(withYear ? { year: 'numeric' as const } : {}),
      ...(timeZone ? { timeZone } : {}),
    });
    calendarDateFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

function calendarDayNumber(value: Date, timeZone?: string) {
  const [year, month, day] = formatDesktopDate(value, { timeZone }).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function plural(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * Messaging-app presence line for a person: "online", "away", or "last seen …" with a relative time
 * for the last few hours and a 24-hour clock time after that. Returns null when presence is unknown,
 * so callers can fall back to another line.
 */
export function formatPresenceLine(
  status: string | null | undefined,
  lastSeenAt: string | number | Date | null | undefined,
  now: Date | number = Date.now(),
  options: { timeZone?: string } = {},
): string | null {
  const normalizedStatus = status?.trim().toLowerCase() ?? '';
  if (!normalizedStatus) return null;
  if (normalizedStatus === 'online') return 'online';
  if (normalizedStatus === 'away') return 'away';

  const seenMs = lastSeenAt instanceof Date
    ? lastSeenAt.getTime()
    : typeof lastSeenAt === 'number'
      ? lastSeenAt
      : Date.parse(lastSeenAt ?? '');
  if (!Number.isFinite(seenMs)) return 'last seen recently';

  const nowDate = now instanceof Date ? now : new Date(now);
  const seen = new Date(seenMs);
  const elapsedMs = nowDate.getTime() - seenMs;
  if (elapsedMs < MINUTE_MS) return 'last seen just now';
  if (elapsedMs < HOUR_MS) return `last seen ${plural(Math.floor(elapsedMs / MINUTE_MS), 'minute')} ago`;
  if (elapsedMs < RELATIVE_HOURS_LIMIT_MS) return `last seen ${plural(Math.floor(elapsedMs / HOUR_MS), 'hour')} ago`;

  const { timeZone } = options;
  const time = formatDesktopClockTime(seen, { timeZone });
  const dayDifference = calendarDayNumber(nowDate, timeZone) - calendarDayNumber(seen, timeZone);
  if (dayDifference <= 0) return `last seen today at ${time}`;
  if (dayDifference === 1) return `last seen yesterday at ${time}`;
  const sameYear = formatDesktopDate(seen, { timeZone }).slice(0, 4) === formatDesktopDate(nowDate, { timeZone }).slice(0, 4);
  return `last seen ${calendarDateLabel(seen, !sameYear, timeZone)}`;
}

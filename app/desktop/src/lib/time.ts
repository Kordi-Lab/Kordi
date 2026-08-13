type DesktopClockTimeOptions = {
  includeSeconds?: boolean;
  timeZone?: string;
};

type DesktopLastActiveOptions = {
  now?: Date | number;
  timeZone?: string;
};

type DesktopTranscriptTimeOptions = DesktopLastActiveOptions & {
  locales?: Intl.LocalesArgument;
};

function toDate(value: Date | number) {
  return value instanceof Date ? value : new Date(value);
}

const desktopClockTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const desktopDateFormatters = new Map<string, Intl.DateTimeFormat>();
const desktopDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const desktopTranscriptTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const desktopRelativeDayFormatters = new Map<string, Intl.RelativeTimeFormat>();

function formatterKey(parts: Array<string | boolean | undefined>) {
  return parts.map((part) => String(part ?? '')).join('|');
}

function localesKey(locales?: Intl.LocalesArgument) {
  if (!locales) return '';
  return Array.isArray(locales) ? locales.join(',') : String(locales);
}

function cachedFormatter(cache: Map<string, Intl.DateTimeFormat>, key: string, locales: Intl.LocalesArgument, options: Intl.DateTimeFormatOptions) {
  const existing = cache.get(key);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat(locales, options);
  cache.set(key, formatter);
  return formatter;
}

function cachedRelativeFormatter(key: string, locales: Intl.LocalesArgument) {
  const existing = desktopRelativeDayFormatters.get(key);
  if (existing) return existing;
  const formatter = new Intl.RelativeTimeFormat(locales, { numeric: 'auto' });
  desktopRelativeDayFormatters.set(key, formatter);
  return formatter;
}

function calendarDayNumber(value: Date | number, timeZone?: string) {
  const [year, month, day] = formatDesktopDate(value, { timeZone }).split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function capitalizeLocaleLabel(value: string, locales?: Intl.LocalesArgument) {
  const [first, ...rest] = Array.from(value);
  return first ? `${first.toLocaleUpperCase(locales)}${rest.join('')}` : value;
}

export function formatDesktopClockTime(value: Date | number, options: DesktopClockTimeOptions = {}) {
  const formatter = cachedFormatter(
    desktopClockTimeFormatters,
    formatterKey([Boolean(options.includeSeconds), options.timeZone]),
    undefined,
    {
      hour: '2-digit',
      minute: '2-digit',
      ...(options.includeSeconds ? { second: '2-digit' as const } : {}),
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      hourCycle: 'h23',
    },
  );
  return formatter.format(toDate(value));
}

export function formatDesktopDate(value: Date | number, options: { timeZone?: string } = {}) {
  const formatter = cachedFormatter(
    desktopDateFormatters,
    formatterKey([options.timeZone]),
    'en-CA',
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    },
  );
  const parts = formatter.formatToParts(toDate(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function formatDesktopLastActiveLabel(value: Date | number, options: DesktopLastActiveOptions = {}) {
  const date = toDate(value);
  const now = options.now ? toDate(options.now) : new Date();
  const timeZone = options.timeZone;
  const dateLabel = formatDesktopDate(date, { timeZone });
  const nowLabel = formatDesktopDate(now, { timeZone });
  if (dateLabel === nowLabel) return formatDesktopClockTime(date, { timeZone });

  const [year, month, day] = dateLabel.split('-');
  const [currentYear] = nowLabel.split('-');
  return year === currentYear
    ? `${day}/${month}`
    : `${day}/${month}/${year}`;
}

export function formatDesktopDateTime(value: Date | number, options: { timeZone?: string } = {}) {
  const formatter = cachedFormatter(
    desktopDateTimeFormatters,
    formatterKey([options.timeZone]),
    undefined,
    {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      hourCycle: 'h23',
    },
  );
  return formatter.format(toDate(value));
}

/**
 * Formats the low-emphasis timestamp shown between transcript message runs.
 * The exact clock time stays locale-aware while recent dates use the compact
 * today / yesterday / weekday hierarchy familiar from messaging apps.
 */
export function formatDesktopTranscriptTimeLabel(
  value: Date | number,
  options: DesktopTranscriptTimeOptions = {},
) {
  const date = toDate(value);
  const now = options.now ? toDate(options.now) : new Date();
  const locales = options.locales;
  const locale = localesKey(locales);
  const timeZone = options.timeZone;
  const time = cachedFormatter(
    desktopTranscriptTimeFormatters,
    formatterKey(['clock', locale, timeZone]),
    locales,
    {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    },
  ).format(date);
  const dayDifference = calendarDayNumber(now, timeZone) - calendarDayNumber(date, timeZone);

  if (dayDifference === 0) return time;
  if (dayDifference === 1) {
    const relative = cachedRelativeFormatter(
      formatterKey([locale]),
      locales,
    ).format(-1, 'day');
    return `${capitalizeLocaleLabel(relative, locales)} ${time}`;
  }
  if (dayDifference > 1 && dayDifference < 7) {
    const weekday = cachedFormatter(
      desktopTranscriptTimeFormatters,
      formatterKey(['weekday', locale, timeZone]),
      locales,
      {
        weekday: 'long',
        ...(timeZone ? { timeZone } : {}),
      },
    ).format(date);
    return `${weekday} ${time}`;
  }

  const dateLabel = formatDesktopDate(date, { timeZone });
  const nowLabel = formatDesktopDate(now, { timeZone });
  const [year] = dateLabel.split('-');
  const [currentYear] = nowLabel.split('-');
  const calendarDate = cachedFormatter(
    desktopTranscriptTimeFormatters,
    formatterKey([year === currentYear ? 'date' : 'date-year', locale, timeZone]),
    locales,
    {
      ...(year === currentYear ? {} : { year: 'numeric' as const }),
      month: 'short',
      day: 'numeric',
      ...(timeZone ? { timeZone } : {}),
    },
  ).format(date);
  return `${calendarDate} ${time}`;
}

export function formatDesktopContactRequestTimeLabel(
  value: string,
  options: DesktopTranscriptTimeOptions = {},
) {
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs)
    ? formatDesktopTranscriptTimeLabel(timestampMs, options)
    : value;
}

type DesktopClockTimeOptions = {
  includeSeconds?: boolean;
  timeZone?: string;
};

type DesktopLastActiveOptions = {
  now?: Date | number;
  timeZone?: string;
};

function toDate(value: Date | number) {
  return value instanceof Date ? value : new Date(value);
}

const desktopClockTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const desktopDateFormatters = new Map<string, Intl.DateTimeFormat>();
const desktopDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterKey(parts: Array<string | boolean | undefined>) {
  return parts.map((part) => String(part ?? '')).join('|');
}

function cachedFormatter(cache: Map<string, Intl.DateTimeFormat>, key: string, locales: Intl.LocalesArgument, options: Intl.DateTimeFormatOptions) {
  const existing = cache.get(key);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat(locales, options);
  cache.set(key, formatter);
  return formatter;
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
  return formatDesktopDate(date, { timeZone }) === formatDesktopDate(now, { timeZone })
    ? formatDesktopClockTime(date, { timeZone })
    : formatDesktopDate(date, { timeZone });
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

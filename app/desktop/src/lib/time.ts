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

export function formatDesktopClockTime(value: Date | number, options: DesktopClockTimeOptions = {}) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(options.includeSeconds ? { second: '2-digit' as const } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    hourCycle: 'h23',
  }).format(toDate(value));
}

export function formatDesktopDate(value: Date | number, options: { timeZone?: string } = {}) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).formatToParts(toDate(value));
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
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    hourCycle: 'h23',
  }).format(toDate(value));
}

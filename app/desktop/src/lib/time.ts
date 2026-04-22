type DesktopClockTimeOptions = {
  includeSeconds?: boolean;
};

function toDate(value: Date | number) {
  return value instanceof Date ? value : new Date(value);
}

export function formatDesktopClockTime(value: Date | number, options: DesktopClockTimeOptions = {}) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(options.includeSeconds ? { second: '2-digit' as const } : {}),
    hourCycle: 'h23',
  }).format(toDate(value));
}

export function formatDesktopDateTime(value: Date | number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(toDate(value));
}

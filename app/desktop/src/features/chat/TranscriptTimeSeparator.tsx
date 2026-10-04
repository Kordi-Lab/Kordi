import { useState } from 'react';
import { formatDesktopTranscriptDetailedTimeLabel } from '@/lib/time';

export function TranscriptTimeSeparator({ timestampMs, label, timeZone, dateOnly = false }: {
  timestampMs: number;
  label: string;
  timeZone: string;
  dateOnly?: boolean;
}) {
  const [detailed, setDetailed] = useState(false);
  if (dateOnly) return (
    <div className="app-thread-date-divider" role="separator" aria-label={label}
      data-transcript-date-divider="true" data-transcript-leading-decoration="true">
      <span aria-hidden="true" />
      <time dateTime={new Date(timestampMs).toISOString()}>{label}</time>
      <span aria-hidden="true" />
    </div>
  );
  const visibleLabel = detailed
    ? formatDesktopTranscriptDetailedTimeLabel(timestampMs, { timeZone })
    : label;
  return (
    <div
      className="app-transcript-time-separator flex justify-center px-2 py-1 text-center text-[11px] font-normal leading-4 tabular-nums text-[color:var(--utility-muted-text)]"
      data-transcript-time-separator="true"
    >
      <button
        type="button"
        className="cursor-pointer rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        aria-label={`${detailed ? 'Show compact time' : 'Show detailed date and time'}: ${visibleLabel}`}
        aria-pressed={detailed}
        onClick={() => setDetailed((current) => !current)}
      >
        <time dateTime={new Date(timestampMs).toISOString()}>{visibleLabel}</time>
      </button>
    </div>
  );
}

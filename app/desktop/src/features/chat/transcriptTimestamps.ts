import type { Message } from '@/kordi-app/types';
import { formatDesktopDate, formatDesktopTranscriptTimeLabel } from '@/lib/time';

export const TRANSCRIPT_TIME_SEPARATOR_GAP_MS = 30 * 60 * 1_000;

type TranscriptTimeSeparatorOptions = {
  now?: Date | number;
  timeZone?: string;
  locales?: Intl.LocalesArgument;
  gapMs?: number;
};

function usableTimestamp(value?: number | null): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && !Number.isNaN(new Date(value).getTime());
}

function canAnchorTranscriptTime(message: Message) {
  return message.role !== 'action'
    && message.role !== 'edit';
}

function isTranscriptEvent(message: Message) {
  return message.role === 'system' || Boolean(message.callActivity);
}

/**
 * Produces one label slot per rendered message. The first timestamped message
 * is labelled, followed by another label when at least thirty minutes have
 * elapsed since the last displayed label or the viewer's calendar day changes.
 */
export function transcriptTimeSeparatorLabels(
  messages: readonly Message[],
  options: TranscriptTimeSeparatorOptions = {},
) {
  const labels: Array<string | null> = Array.from({ length: messages.length }, () => null);
  const gapMs = Math.max(0, options.gapMs ?? TRANSCRIPT_TIME_SEPARATOR_GAP_MS);
  let lastShownTimestampMs: number | null = null;
  let lastShownCalendarDay: string | null = null;

  messages.forEach((message, index) => {
    const timestampMs = message.timestampMs;
    if (!canAnchorTranscriptTime(message) || !usableTimestamp(timestampMs)) return;
    if (lastShownTimestampMs !== null && timestampMs < lastShownTimestampMs) return;
    const calendarDay = formatDesktopDate(timestampMs, { timeZone: options.timeZone });
    const isFirstTimestamp = lastShownTimestampMs === null;
    const isLaterCalendarDay = lastShownCalendarDay !== null && calendarDay !== lastShownCalendarDay;
    const reachesGap = lastShownTimestampMs !== null && timestampMs - lastShownTimestampMs >= gapMs;
    if (!isTranscriptEvent(message) && !isFirstTimestamp && !isLaterCalendarDay && !reachesGap) return;

    labels[index] = formatDesktopTranscriptTimeLabel(timestampMs, options);
    lastShownTimestampMs = timestampMs;
    lastShownCalendarDay = calendarDay;
  });

  return labels;
}

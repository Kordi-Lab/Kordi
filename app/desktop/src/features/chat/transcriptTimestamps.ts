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

type SeparatorInput = {
  timestampMs: number | null | undefined;
  canAnchor: boolean;
};

type SeparatorAnchor = { timestampMs: number; calendarDay: string } | null;

/** Cache the unchanged prefix so receipts and appends do not reformat old dates. */
export function createTranscriptTimeSeparatorCache() {
  let contextKey = '';
  let inputs: SeparatorInput[] = [];
  let anchors: SeparatorAnchor[] = [];
  let labels: Array<string | null> = [];

  return (messages: readonly Message[], options: TranscriptTimeSeparatorOptions = {}) => {
    const gapMs = Math.max(0, options.gapMs ?? TRANSCRIPT_TIME_SEPARATOR_GAP_MS);
    const now = options.now ?? Date.now();
    const nextContextKey = JSON.stringify([
      formatDesktopDate(now, { timeZone: options.timeZone }),
      options.timeZone, options.locales, gapMs,
    ]);
    let start = 0;
    if (contextKey === nextContextKey) {
      while (start < messages.length && start < inputs.length) {
        const message = messages[start];
        const previous = inputs[start];
        if (!Object.is(previous.timestampMs, message.timestampMs)
          || previous.canAnchor !== canAnchorTranscriptTime(message)) break;
        start += 1;
      }
      if (start === messages.length && start === inputs.length) return labels;
    }

    const nextInputs = inputs.slice(0, start);
    const nextAnchors = anchors.slice(0, start);
    const nextLabels = labels.slice(0, start);
    let anchor = nextAnchors[start - 1] ?? null;
    for (let index = start; index < messages.length; index += 1) {
      const message = messages[index];
      const timestampMs = message.timestampMs;
      const input = { timestampMs, canAnchor: canAnchorTranscriptTime(message) };
      nextInputs.push(input);
      let label: string | null = null;
      if (input.canAnchor && usableTimestamp(timestampMs) && (!anchor || timestampMs >= anchor.timestampMs)) {
        const calendarDay = formatDesktopDate(timestampMs, { timeZone: options.timeZone });
        if (!anchor || calendarDay !== anchor.calendarDay || timestampMs - anchor.timestampMs >= gapMs) {
          label = formatDesktopTranscriptTimeLabel(timestampMs, { ...options, now });
        }
        // Compare adjacent messages, so prepending history cannot re-phase later labels.
        anchor = { timestampMs, calendarDay };
      }
      nextLabels.push(label);
      nextAnchors.push(anchor);
    }
    contextKey = nextContextKey;
    inputs = nextInputs;
    anchors = nextAnchors;
    labels = nextLabels;
    return labels;
  };
}

/** One slot per message; label the first timestamp, day changes, and 30-minute gaps. */
export function transcriptTimeSeparatorLabels(
  messages: readonly Message[],
  options: TranscriptTimeSeparatorOptions = {},
) {
  return createTranscriptTimeSeparatorCache()(messages, options);
}

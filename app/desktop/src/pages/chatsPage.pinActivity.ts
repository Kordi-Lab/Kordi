import type { Message } from '@/kordi-app/types';

export type PinActivity = {
  id: string;
  label: string;
  timestampMs: number;
};

export type MessageTimelineEntry = { message: Message; originalIndex: number };
export type PinActivityTimelineEntry = { pinActivity: PinActivity };
export type PinTimelineEntry = MessageTimelineEntry | PinActivityTimelineEntry;

export function createPinActivity(id: string, label: string, occurredAt: string | null | undefined): PinActivity | null {
  const timestampMs = occurredAt ? Date.parse(occurredAt) : NaN;
  return Number.isFinite(timestampMs) ? { id, label, timestampMs } : null;
}

// Preserve the existing transcript order (including request/reply grouping).
// Only the notice is inserted, without changing real message identities or indices.
export function insertPinActivity(
  entries: readonly MessageTimelineEntry[],
  activity: PinActivity | null | undefined,
): PinTimelineEntry[] {
  if (!activity || !Number.isFinite(activity.timestampMs)) return [...entries];
  const nextIndex = entries.findIndex(({ message }) => (
    typeof message.timestampMs === 'number'
      && Number.isFinite(message.timestampMs)
      && message.timestampMs > activity.timestampMs
  ));
  const index = nextIndex < 0 ? entries.length : nextIndex;
  return [...entries.slice(0, index), { pinActivity: activity }, ...entries.slice(index)];
}

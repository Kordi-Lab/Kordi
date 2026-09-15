import type { Message } from '@/kordi-app/types';

export type PinActivity = {
  id: string;
  sequence?: number;
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
export function insertPinActivities(entries: readonly MessageTimelineEntry[], activities: readonly PinActivity[] = []): PinTimelineEntry[] {
  const unique = new Map(activities.filter((event) => Number.isFinite(event.timestampMs)).map((event) => [event.id, event]));
  const sorted = [...unique.values()].sort((a, b) => a.timestampMs - b.timestampMs || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));
  const rows: PinTimelineEntry[] = [];
  let index = 0;
  for (const entry of entries) {
    while (index < sorted.length && typeof entry.message.timestampMs === 'number' && sorted[index].timestampMs < entry.message.timestampMs) {
      rows.push({ pinActivity: sorted[index++] });
    }
    rows.push(entry);
  }
  for (; index < sorted.length; index += 1) rows.push({ pinActivity: sorted[index] });
  return rows;
}

import type { CalendarEvent } from './types';

export type CalendarImportReport = {
  imported: number;
  duplicates: number;
  skipped: Array<{ title: string; reason: string }>;
};

export function calendarErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : typeof error === 'string' && error.trim() ? error : fallback;
}

export function normalizeCalendarEvent(event: CalendarEvent): CalendarEvent {
  const start = Date.parse(event.startAt);
  const end = event.endAt ? Date.parse(event.endAt) : null;
  if (!Number.isFinite(start)) throw new Error('Start date is missing or invalid.');
  if (end !== null && !Number.isFinite(end)) throw new Error('End date is invalid.');
  if (end !== null && end < start) throw new Error('End date is before start.');
  // EventKit can return an instant with identical endpoints. The API represents it without an end.
  return { ...event, endAt: end === start ? null : event.endAt };
}

export async function importCalendarEvents(
  incoming: CalendarEvent[], existing: CalendarEvent[], save: (event: CalendarEvent) => Promise<unknown>,
): Promise<CalendarImportReport> {
  const report: CalendarImportReport = { imported: 0, duplicates: 0, skipped: [] };
  const ids = new Set(existing.map(event => event.id));
  const externalIds = new Set(existing.flatMap(event => event.externalUid ? [event.externalUid] : []));
  for (const event of incoming) {
    if (ids.has(event.id) || (event.externalUid && externalIds.has(event.externalUid))) { report.duplicates++; continue; }
    let normalized: CalendarEvent;
    try { normalized = normalizeCalendarEvent(event); }
    catch (error) { report.skipped.push({ title: event.title || 'Untitled event', reason: calendarErrorMessage(error, 'Invalid date.') }); continue; }
    try { await save(normalized); }
    catch (error) {
      const message = calendarErrorMessage(error, 'Could not save this event.');
      if (typeof error === 'object' && error !== null && 'status' in error && (error.status === 400 || error.status === 422)) {
        report.skipped.push({ title: event.title || 'Untitled event', reason: message }); continue;
      }
      throw new Error(`Imported ${report.imported} events before stopping at “${event.title}”. ${message} Retry to continue; saved events will not be duplicated.`);
    }
    report.imported++;
    ids.add(event.id);
    if (event.externalUid) externalIds.add(event.externalUid);
  }
  return report;
}

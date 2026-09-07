import { digestSourceLinks } from './links';
import type { CalendarEvent, DigestItem, DigestSource } from './types';

export function proposalEvent(item: DigestItem, events: CalendarEvent[], sources: DigestSource[], timezone?: string): CalendarEvent {
  if (item.calendarAction === 'delete' && item.calendarScope === 'series') {
    const series = proposalSeries(item,events);
    if (!series?.length) throw new Error('This series changed. Refresh before reviewing its cancellation.');
    return series[0];
  }
  if (item.calendarAction === 'update' || item.calendarAction === 'delete') {
    const saved = events.find(event => event.id === item.existingEventId);
    if (!saved || saved.revision !== item.existingEventRevision) throw new Error('This event changed. Refresh and review the latest suggestion.');
    if (item.calendarAction === 'delete') return saved;
    const startAt = item.startAt ?? saved.startAt;
    const delta = Date.parse(startAt) - Date.parse(saved.startAt);
    return {...saved, title: item.title, startAt, endAt: item.endAt ?? (saved.endAt ? new Date(Date.parse(saved.endAt) + delta).toISOString() : null),
      reminderAt: saved.reminderAt ? new Date(Date.parse(saved.reminderAt) + delta).toISOString() : null,
      timezone: item.timezone ?? saved.timezone,
      sourceIds: [...new Set([...saved.sourceIds, ...item.sourceIds])].slice(-20)};
  }
  return events.find(event => (event.id === `digest-${item.id}` || event.seriesId === `digest-${item.id}`)) ?? {
    id: `digest-${item.id}`, title: item.title, startAt: item.startAt ?? '', endAt: item.endAt,
    allDay: false, description: item.text, sourceIds: item.sourceIds, revision: 0,
    links: digestSourceLinks(item.sourceIds, sources), timezone: item.recurrence?.timezone ?? item.timezone ?? timezone,
    recurrence: item.recurrence,
  };
}

export function proposalSeries(item: DigestItem, events: CalendarEvent[]): CalendarEvent[] | undefined {
  if(item.calendarAction !== 'delete' || item.calendarScope !== 'series' || !item.existingSeriesId)return;
  return events.filter(event=>event.seriesId===item.existingSeriesId).sort((a,b)=>Date.parse(a.startAt)-Date.parse(b.startAt));
}

export function proposalLabel(item: DigestItem, events: CalendarEvent[]): string {
  if (item.calendarAction === 'delete') return 'Review cancellation';
  if (item.calendarAction === 'update') return 'Review change';
  return events.some(event => (event.id === `digest-${item.id}` || event.seriesId === `digest-${item.id}`)) ? 'View event' : 'Review & add';
}

export function isPendingCalendarProposal(item: DigestItem, events: CalendarEvent[]): boolean {
  if(!calendarProposalAvailable(item,events))return false;
  return item.calendarAction === 'update' || item.calendarAction === 'delete'
    || !events.some(event => event.id === `digest-${item.id}` || event.seriesId === `digest-${item.id}`);
}

export function calendarProposalAvailable(item: DigestItem, events: CalendarEvent[]): boolean {
  if(item.calendarAction!=='delete')return true;
  return events.some(event=>event.revision>0&&(item.calendarScope==='series'
    ?!!item.existingSeriesId&&event.seriesId===item.existingSeriesId:event.id===item.existingEventId));
}

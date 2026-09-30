import type { CalendarEvent } from '@/features/digest/types';
import { dateKey, eventOnDay } from '@/features/digest/calendar';

export function companionAgendaDays(selectedDay: string, events: CalendarEvent[]) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${selectedDay}T12:00:00`);
    date.setDate(date.getDate() + index);
    const day = dateKey(date);
    return { day, events: events.filter(event => eventOnDay(event, day)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.startAt) - Date.parse(b.startAt)) };
  });
}

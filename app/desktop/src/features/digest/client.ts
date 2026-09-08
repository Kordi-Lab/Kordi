import { cloudApiBaseUrl } from '@/features/cloud/authClient';
import { normalizeCalendarEvent } from './calendarImport';
import { loadSession } from '@/features/cloud/session';
import type { CalendarEvent, DigestResponse } from './types';

async function request<T>(accountId: string, path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const session = await loadSession();
  if (!session || session.accountId !== accountId) throw new Error('Sign in again to open your digest.');
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  try {
    const response = await fetch(`${cloudApiBaseUrl()}/v1/cloud/${path}`, {
      method, signal: controller.signal,
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let result: unknown;
    try { result = text ? JSON.parse(text) : undefined; } catch { throw new Error('The server returned an unreadable response.'); }
    if (!response.ok) throw Object.assign(new Error((result as { message?: string })?.message || 'Could not update the digest.'), { status: response.status });
    return result as T;
  } catch (error) {
    if (timedOut) throw new Error('The request timed out. Try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
export const digestClient = {
  async read(accountId: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const response = await request<DigestResponse>(accountId, `digest?${query}`, 'GET', undefined, signal);
    if (response.accountId !== accountId) throw new Error('Digest account did not match the signed-in account.');
    return response;
  },
  refresh: (accountId: string) => request<void>(accountId, `digest/refresh?${new URLSearchParams({ locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}`, 'POST'),
  calendar: (accountId: string, signal?: AbortSignal) => request<{ events: CalendarEvent[] }>(accountId, 'calendar/events', 'GET', undefined, signal),
  saveEvent: (accountId: string, event: CalendarEvent) => request<CalendarEvent>(accountId, `calendar/events/${encodeURIComponent(event.id)}`, 'PUT', normalizeCalendarEvent(event)),
  previewSeries: (accountId: string, event: CalendarEvent, signal?: AbortSignal) => request<{events: CalendarEvent[]}>(accountId, 'calendar/series/preview', 'POST', normalizeCalendarEvent(event), signal),
  saveSeries: (accountId: string, event: CalendarEvent) => request<{events: CalendarEvent[]}>(accountId, `calendar/series/${encodeURIComponent(event.id)}`, 'PUT', normalizeCalendarEvent(event)),
  removeEvent: (accountId: string, event: CalendarEvent) => request<void>(accountId, `calendar/events/${encodeURIComponent(event.id)}?revision=${event.revision}`, 'DELETE'),
  removeSeries: (accountId: string, id: string, events: CalendarEvent[]) => request<void>(accountId, `calendar/series/${encodeURIComponent(id)}`, 'DELETE', {events:events.map(event=>({id:event.id,revision:event.revision}))}),
  feedback: (accountId: string, id: string, dismissed: boolean) => request<void>(accountId, `digest/items/${encodeURIComponent(id)}/feedback`, 'PUT', { dismissed }),
  task: (accountId: string, id: string, input: { title: string; ownerAccountId: string | null; dueAt: string | null }) => request<{ taskId: string }>(accountId, `digest/items/${encodeURIComponent(id)}/task`, 'POST', input),
};

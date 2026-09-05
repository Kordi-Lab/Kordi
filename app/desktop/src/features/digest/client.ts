import { cloudApiBaseUrl } from '@/features/cloud/authClient';
import { loadSession } from '@/features/cloud/session';
import type { CalendarEvent, DigestResponse } from './types';

async function request<T>(accountId: string, path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const session = await loadSession();
  if (!session || session.accountId !== accountId) throw new Error('Sign in again to open your digest.');
  const response = await fetch(`${cloudApiBaseUrl()}/v1/cloud/${path}`, {
    method, signal: signal ?? AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let result: unknown;
  try { result = text ? JSON.parse(text) : undefined; } catch { throw new Error('The server returned an unreadable response.'); }
  if (!response.ok) throw new Error((result as { message?: string })?.message || 'Could not update the digest.');
  return result as T;
}
export const digestClient = {
  async read(accountId: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const response = await request<DigestResponse>(accountId, `digest?${query}`, 'GET', undefined, signal);
    if (response.accountId !== accountId) throw new Error('Digest account did not match the signed-in account.');
    return response;
  },
  refresh: (accountId: string) => request<void>(accountId, 'digest/refresh', 'POST'),
  calendar: (accountId: string, signal?: AbortSignal) => request<{ events: CalendarEvent[] }>(accountId, 'calendar/events', 'GET', undefined, signal),
  saveEvent: (accountId: string, event: CalendarEvent) => request<CalendarEvent>(accountId, `calendar/events/${encodeURIComponent(event.id)}`, 'PUT', event),
  removeEvent: (accountId: string, event: CalendarEvent) => request<void>(accountId, `calendar/events/${encodeURIComponent(event.id)}?revision=${event.revision}`, 'DELETE'),
  feedback: (accountId: string, id: string, dismissed: boolean) => request<void>(accountId, `digest/items/${encodeURIComponent(id)}/feedback`, 'PUT', { dismissed }),
  task: (accountId: string, id: string, input: { title: string; ownerAccountId: string | null; dueAt: string | null }) => request<{ taskId: string }>(accountId, `digest/items/${encodeURIComponent(id)}/task`, 'POST', input),
};

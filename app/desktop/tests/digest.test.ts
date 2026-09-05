import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { dateKey, eventOnDay, monthDays } from '../src/features/digest/calendar';
import type { CalendarEvent } from '../src/features/digest/types';
import { digestClient } from '../src/features/digest/client';
import { __setSessionBackendForTests } from '../src/features/cloud/session';

const require = createRequire(import.meta.url);
const parser = require('../../../shared/digest/import.js') as { parse(text: string, from: string, to: string): { events: Array<{ id: string; date: string; allDay: boolean }>; warnings: string[] } };

test('Digest calendar keeps all-day exclusive ends independent of device timezone', () => {
  const event: CalendarEvent = { id: 'planning', title: 'Planning', startAt: '2026-09-10T00:00:00Z', endAt: '2026-09-12T00:00:00Z', allDay: true, description: '', sourceIds: [], revision: 1 };
  assert.equal(eventOnDay(event, '2026-09-10'), true);
  assert.equal(eventOnDay(event, '2026-09-11'), true);
  assert.equal(eventOnDay(event, '2026-09-12'), false);
  assert.equal(monthDays('2026-09').length, 42);
  assert.equal(monthDays('2026-09')[0], '2026-08-30');
  assert.equal(dateKey(new Date(2026, 8, 10, 12)), '2026-09-10');
});

test('Shared ICS parser expands recurrence and excludes exceptions without changing source identity', () => {
  const text = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:review\nDTSTAMP:20260901T000000Z\nDTSTART:20260909T120000Z\nDTEND:20260909T123000Z\nRRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20260916T120000Z\nSUMMARY:Review\nEND:VEVENT\nEND:VCALENDAR';
  const first = parser.parse(text, '2026-09-01', '2026-10-01');
  const second = parser.parse(text, '2026-09-01', '2026-10-01');
  assert.equal(first.events.length, 2);
  assert.deepEqual(first.events.map(e => e.id), second.events.map(e => e.id));
  assert.ok(!first.events.some(e => e.date === '2026-09-16'));
  assert.throws(() => parser.parse('not an ICS file', '2026-09-01', '2026-10-01'));
});

test('Digest requests cannot use a different account session', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  __setSessionBackendForTests({ load: () => Promise.resolve({ token: 'test-only-token', accountId: 'other', expiresAt: '2099-01-01T00:00:00Z' }), save: () => Promise.resolve(), clear: () => Promise.resolve() });
  globalThis.fetch = () => { calls++; return Promise.resolve(new Response('{}')); };
  try { await assert.rejects(digestClient.read('viewer'), /Sign in again/); assert.equal(calls, 0); }
  finally { globalThis.fetch = originalFetch; __setSessionBackendForTests(null); }
});

test('Calendar import normalizes instant events, isolates bad records, and deduplicates retries', async () => {
  const { importCalendarEvents, normalizeCalendarEvent } = await import('../src/features/digest/calendarImport');
  const base: CalendarEvent = { id: 'instant', title: 'Point event', startAt: '2026-09-06T12:00:00Z', endAt: '2026-09-06T15:00:00+03:00', allDay: false, description: '', sourceIds: [], revision: 0 };
  assert.equal(normalizeCalendarEvent(base).endAt, null);
  assert.equal(normalizeCalendarEvent({ ...base, allDay: true }).endAt, null);
  const saved: CalendarEvent[] = [];
  const input = [base, { ...base, id: 'bad', title: 'Invalid range', endAt: '2026-09-06T11:00:00Z' }, { ...base, id: 'next', title: 'Later event', endAt: '2026-09-06T13:00:00Z' }, base];
  const first = await importCalendarEvents(input, [], async event => { saved.push(event); });
  assert.equal(first.imported, 2); assert.equal(first.duplicates, 1); assert.equal(first.skipped[0].title, 'Invalid range');
  assert.deepEqual(saved.map(event => event.id), ['instant', 'next']);
  const retry = await importCalendarEvents(input, saved, async () => { assert.fail('Already imported event was submitted again'); });
  assert.equal(retry.imported, 0); assert.equal(retry.duplicates, 3);
});

test('Calendar import stops on connection failure and reports the partial result', async () => {
  const { importCalendarEvents } = await import('../src/features/digest/calendarImport');
  const base: CalendarEvent = { id: 'one', title: 'First', startAt: '2026-09-06T12:00:00Z', allDay: false, description: '', sourceIds: [], revision: 0 };
  const skipped = await importCalendarEvents([base, { ...base, id: 'invalid' }, { ...base, id: 'last' }], [], async event => { if (event.id === 'invalid') throw Object.assign(new Error('Invalid calendar event.'), { status: 400 }); });
  assert.equal(skipped.imported, 2); assert.equal(skipped.skipped.length, 1);
  let calls = 0;
  await assert.rejects(importCalendarEvents([base, { ...base, id: 'two', title: 'Second' }, { ...base, id: 'three' }], [], async () => { if (++calls === 2) throw new Error('Connection lost.'); }), /Imported 1 events before stopping at “Second”/);
  assert.equal(calls, 2);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatPresenceLine } from '../src/kordi-app/contactPresenceLine';
import { contactSecondaryLine } from '../src/kordi-app/contactPresentation';
import { contact } from './helpers/contactsPageFixtures';

const NOW = Date.parse('2026-10-18T15:30:00Z');
const UTC = { timeZone: 'UTC' };
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test('presence line reads online and away as plain words', () => {
  assert.equal(formatPresenceLine('online', null, NOW, UTC), 'online');
  assert.equal(formatPresenceLine('Online', ago(5 * HOUR), NOW, UTC), 'online');
  assert.equal(formatPresenceLine('away', null, NOW, UTC), 'away');
});

test('presence line is unknown without a status', () => {
  assert.equal(formatPresenceLine(null, ago(MINUTE), NOW, UTC), null);
  assert.equal(formatPresenceLine(undefined, null, NOW, UTC), null);
  assert.equal(formatPresenceLine('  ', null, NOW, UTC), null);
});

test('offline without a last-seen time reads "last seen recently"', () => {
  assert.equal(formatPresenceLine('offline', null, NOW, UTC), 'last seen recently');
  assert.equal(formatPresenceLine('offline', 'not a date', NOW, UTC), 'last seen recently');
});

test('recent last-seen times are relative', () => {
  assert.equal(formatPresenceLine('offline', ago(20_000), NOW, UTC), 'last seen just now');
  assert.equal(formatPresenceLine('offline', ago(-20_000), NOW, UTC), 'last seen just now');
  assert.equal(formatPresenceLine('offline', ago(MINUTE), NOW, UTC), 'last seen 1 minute ago');
  assert.equal(formatPresenceLine('offline', ago(9 * MINUTE + 30_000), NOW, UTC), 'last seen 9 minutes ago');
  assert.equal(formatPresenceLine('offline', ago(59 * MINUTE), NOW, UTC), 'last seen 59 minutes ago');
  assert.equal(formatPresenceLine('offline', ago(HOUR), NOW, UTC), 'last seen 1 hour ago');
  assert.equal(formatPresenceLine('offline', ago(5 * HOUR + 50 * MINUTE), NOW, UTC), 'last seen 5 hours ago');
});

test('older last-seen times name the day and a 24-hour clock time', () => {
  assert.equal(formatPresenceLine('offline', '2026-10-18T08:05:00Z', NOW, UTC), 'last seen today at 08:05');
  assert.equal(formatPresenceLine('offline', '2026-10-17T18:58:00Z', NOW, UTC), 'last seen yesterday at 18:58');
  assert.equal(formatPresenceLine('offline', '2026-10-12T09:00:00Z', NOW, UTC), 'last seen Oct 12');
  assert.equal(formatPresenceLine('offline', '2025-12-30T09:00:00Z', NOW, UTC), 'last seen Dec 30, 2025');
});

test('contact second line shows presence for people and the description for agents', () => {
  const person = contact({ subtitle: '@482731906', presenceStatus: 'online' });
  assert.deepEqual(contactSecondaryLine(person, NOW), { text: 'online', online: true });

  const seen = contact({ subtitle: '@482731906', presenceStatus: 'offline', presenceLastSeenAt: ago(9 * MINUTE) });
  assert.deepEqual(contactSecondaryLine(seen, NOW), { text: 'last seen 9 minutes ago', online: false });

  const noTimestamp = contact({ subtitle: '@482731906', presenceStatus: 'offline' });
  assert.equal(contactSecondaryLine(noTimestamp, NOW).text, 'last seen recently');

  const unknown = contact({ subtitle: '@482731906', presenceStatus: null });
  assert.equal(contactSecondaryLine(unknown, NOW).text, '@482731906');

  const support = contact({ subtitle: 'Ask questions or suggest improvements', presenceStatus: 'online', systemContact: true });
  assert.deepEqual(contactSecondaryLine(support, NOW), { text: 'Ask questions or suggest improvements', online: false });

  const agent = contact({ classType: 'my-agents', subtitle: 'On this Mac', presenceStatus: 'offline' });
  assert.equal(contactSecondaryLine(agent, NOW).text, 'On this Mac');
});

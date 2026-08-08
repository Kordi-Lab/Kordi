import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CanonicalSessionMessage } from '../src/kordi-app/types';
import { sessionChatActivityAtMs } from '../src/features/canonical/readModel/conversationMapping';
import { formatDesktopLastActiveLabel, formatDesktopTranscriptTimeLabel } from '../src/lib/time';

test('formatDesktopTranscriptTimeLabel uses compact messaging labels in the viewer timezone', () => {
  const now = new Date('2026-08-08T14:00:00.000Z');

  assert.equal(
    formatDesktopTranscriptTimeLabel(new Date('2026-08-08T13:00:00.000Z'), { now, timeZone: 'UTC', locales: 'en-US' }),
    '13:00',
  );
  assert.equal(
    formatDesktopTranscriptTimeLabel(new Date('2026-08-07T13:00:00.000Z'), { now, timeZone: 'UTC', locales: 'en-US' }),
    'Yesterday 13:00',
  );
  assert.equal(
    formatDesktopTranscriptTimeLabel(new Date('2026-08-04T20:23:00.000Z'), { now, timeZone: 'UTC', locales: 'en-US' }),
    'Tuesday 20:23',
  );
  assert.equal(
    formatDesktopTranscriptTimeLabel(new Date('2025-08-04T20:23:00.000Z'), { now, timeZone: 'UTC', locales: 'en-US' }),
    'Aug 4, 2025 20:23',
  );
});

test('formatDesktopLastActiveLabel uses 24h time today and a compact day/month within the current year', () => {
  const now = new Date('2026-05-14T06:30:00.000Z');

  assert.equal(
    formatDesktopLastActiveLabel(new Date('2026-05-14T05:30:00.000Z'), { now, timeZone: 'UTC' }),
    '05:30',
  );
  assert.equal(
    formatDesktopLastActiveLabel(new Date('2026-05-13T23:30:00.000Z'), { now, timeZone: 'UTC' }),
    '13/05',
  );
  assert.equal(
    formatDesktopLastActiveLabel(new Date('2025-07-23T23:30:00.000Z'), { now, timeZone: 'UTC' }),
    '23/07/2025',
  );
});

test('formatDesktopLastActiveLabel compares calendar days in the viewer timezone', () => {
  const now = new Date('2026-05-14T06:30:00.000Z'); // 2026-05-13 23:30 in Los Angeles

  assert.equal(
    formatDesktopLastActiveLabel(new Date('2026-05-13T23:30:00.000Z'), { now, timeZone: 'America/Los_Angeles' }),
    '16:30',
  );
  assert.equal(
    formatDesktopLastActiveLabel(new Date('2026-05-13T06:30:00.000Z'), { now, timeZone: 'America/Los_Angeles' }),
    '12/05',
  );
});

test('formatDesktopLastActiveLabel decides whether to show the year in the viewer timezone', () => {
  const now = new Date('2026-01-01T01:00:00.000Z');

  assert.equal(
    formatDesktopLastActiveLabel(new Date('2025-12-31T23:30:00.000Z'), { now, timeZone: 'UTC' }),
    '31/12/2025',
  );
  assert.equal(
    formatDesktopLastActiveLabel(new Date('2025-12-30T23:30:00.000Z'), { now, timeZone: 'America/Los_Angeles' }),
    '30/12',
  );
});

test('sessionChatActivityAtMs ignores fork snapshot/import rows for last active', () => {
  const realMessageAtMs = Date.parse('2026-05-13T10:00:00.000Z');
  const snapshotImportAtMs = Date.parse('2026-05-14T20:00:00.000Z');
  const session = {
    id: 'session:fork:time',
    kind: 'group',
    title: 'Fork',
    status: 'active',
    createdByIdentityId: 'human:me',
    createdAtMs: Date.parse('2026-05-12T00:00:00.000Z'),
    updatedAtMs: snapshotImportAtMs,
    lastMessageAtMs: snapshotImportAtMs,
  };
  const messages = [
    { id: 'real', sessionId: session.id, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'real', status: 'sent', sequenceNum: 1, createdAtMs: realMessageAtMs, updatedAtMs: realMessageAtMs, sourceTransport: 'cloud-group' },
    { id: 'snapshot', sessionId: session.id, senderIdentityId: 'human:peer', senderRole: 'person', messageKind: 'text', contentText: 'snapshot', status: 'sent', sequenceNum: 2, createdAtMs: snapshotImportAtMs, updatedAtMs: snapshotImportAtMs, sourceTransport: 'cloud-group-fork-snapshot' },
  ] as CanonicalSessionMessage[];

  assert.equal(sessionChatActivityAtMs(session as never, messages), realMessageAtMs);
});

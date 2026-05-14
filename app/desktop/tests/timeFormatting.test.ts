import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CanonicalSessionMessage } from '../src/kordi-app/types';
import { sessionChatActivityAtMs } from '../src/features/canonical/readModel/conversationMapping';
import { formatDesktopLastActiveLabel } from '../src/lib/time';

test('formatDesktopLastActiveLabel uses 24h time for same local day and exact date for older local days', () => {
  const now = new Date('2026-05-14T06:30:00.000Z');

  assert.equal(
    formatDesktopLastActiveLabel(new Date('2026-05-14T05:30:00.000Z'), { now, timeZone: 'UTC' }),
    '05:30',
  );
  assert.equal(
    formatDesktopLastActiveLabel(new Date('2026-05-13T23:30:00.000Z'), { now, timeZone: 'UTC' }),
    '2026-05-13',
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
    '2026-05-12',
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

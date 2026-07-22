import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalMessageCountsForLastActive } from '../src/features/canonical/readModel/conversationMapping';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import {
  canonicalMessageCountsAsReadable,
  isPlaceholderSessionTitleNotice,
} from '../src/features/canonical/readModel/messageVisibility';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';

function sessionTitleNotice(title: string): CanonicalSessionMessage {
  return {
    id: `notice:${title}`,
    sessionId: 'session:group:one',
    senderIdentityId: 'human:relay',
    senderRole: 'system',
    messageKind: 'status',
    contentText: `Relay changed the session name to ${title}`,
    content: { kind: 'session-title-update', scope: 'session', title },
    status: 'complete',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    sourceTransport: 'cloud-group-session-title-update',
  };
}

test('placeholder session title notices stay out of transcripts and activity', () => {
  for (const title of ['New chat', '# New chat', 'New session', 'New fork', 'Untitled session', 'Session']) {
    const notice = sessionTitleNotice(title);
    assert.equal(isPlaceholderSessionTitleNotice(notice), true);
    assert.equal(canonicalMessageCountsAsReadable(notice), false);
    assert.equal(canonicalMessageCountsForLastActive(notice), false);
    assert.equal(mapCanonicalMessage(notice, new Map()), null);
  }
});

test('a real session rename remains visible and counts as activity', () => {
  const notice = sessionTitleNotice('Sprint follow-up');
  assert.equal(isPlaceholderSessionTitleNotice(notice), false);
  assert.equal(canonicalMessageCountsAsReadable(notice), true);
  assert.equal(canonicalMessageCountsForLastActive(notice), true);
  assert.ok(mapCanonicalMessage(notice, new Map()));
});

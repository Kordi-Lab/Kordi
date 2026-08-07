import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalMessageCountsForLastActive } from '../src/features/canonical/readModel/conversationMapping';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import {
  canonicalMessageCountsAsReadable,
  isPlaceholderSessionTitleNotice,
  isSynchronizationOnlyCloudGroupTitleNotice,
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

test('invite-derived group title notices stay hidden while genuine renames remain visible', () => {
  const notice = (sourceControlKind: 'group-invite' | 'group-title-update'): CanonicalSessionMessage => ({
    ...sessionTitleNotice('Research'),
    id: `cloud-group-title-notice:${sourceControlKind}`,
    content: {
      kind: 'group-title-update',
      scope: 'group',
      title: 'Research',
      sourceControlKind,
      ...(sourceControlKind === 'group-invite' ? { synchronizationOnly: true } : {}),
    },
    sourceTransport: 'cloud-group-title-update',
  });
  const inviteCopy = notice('group-invite');
  const genuineRename = notice('group-title-update');
  assert.equal(isSynchronizationOnlyCloudGroupTitleNotice(inviteCopy), true);
  assert.equal(canonicalMessageCountsAsReadable(inviteCopy), false);
  assert.equal(mapCanonicalMessage(inviteCopy, new Map()), null);
  assert.equal(isSynchronizationOnlyCloudGroupTitleNotice(genuineRename), false);
  assert.ok(mapCanonicalMessage(genuineRename, new Map()));
});

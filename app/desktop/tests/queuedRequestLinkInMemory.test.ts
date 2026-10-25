import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeCanonicalMessageRow } from '../src/features/canonical/canonicalStateReducers';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/runtimeHistoryMerge';
import { linkPublishedSelfAgentRequest } from '../src/features/cloud/cloudSelfAgentRequestEntryLink';
import type { CanonicalIdentity, CanonicalSessionMessage, CanonicalSessionState, Message } from '../src/kordi-app/types';

const sessionId = 'session:self';
const wireId = '01a173f0-d3a5-71b3-bae9-a6d03d613de1';
const queued: CanonicalSessionMessage = {
  id: `queued-local-chat:${sessionId}:706bb2af`, sessionId, senderIdentityId: 'human:me', senderRole: 'user',
  messageKind: 'text', contentText: 'dhiqwheiq', content: { queueState: 'sent', deliveryState: 'sent' },
  status: 'sent', parentMessageId: null, sequenceNum: 4, createdAtMs: 1_000, updatedAtMs: 1_000,
  contentHash: null, sourceTransport: 'desktop-chat-ui', sourceEventId: `desktop-chat-ui:queued:${sessionId}:706bb2af`,
};
const state = { sessions: [], participants: [], identities: [], messages: [queued] } as unknown as CanonicalSessionState;
const identities = new Map<string, CanonicalIdentity>();
// The Mac's own transcript copy of the sent request, keyed by its Cloud id.
const runtimeCopy: Message = { id: `desktop-entry:${sessionId}:4`, entryId: wireId, role: 'user', text: 'dhiqwheiq', time: '09:41' };

test('a sent queued request is linked in memory, so it joins the Mac\'s copy instead of repeating', async () => {
  const before = mapCanonicalMessage(queued, identities, 'human:me')!;
  assert.notEqual(before.entryId, wireId, 'unlinked, the stored row cannot name the Mac\'s copy');
  const linked = await linkPublishedSelfAgentRequest(state, queued.id, wireId, async () => undefined);
  const next = mergeCanonicalMessageRow(state, linked)!;
  const mapped = mapCanonicalMessage(next.messages[0], identities, 'human:me')!;
  assert.equal(mapped.entryId, wireId);
  const merged = mergeCanonicalHistoryIntoRuntime([mapped], [runtimeCopy]);
  assert.equal(merged.filter((message) => message.role === 'user').length, 1);
});

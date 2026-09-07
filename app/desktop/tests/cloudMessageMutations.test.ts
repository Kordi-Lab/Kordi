import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import {
  encodeCloudDirectMessageEnvelope,
  parseCloudDirectMessageEnvelope,
} from '../src/features/cloud/cloudDirectMessages';
import {
  encodeCloudGroupControl,
  parseCloudGroupControl,
} from '../src/features/cloud/cloudGroupMessages';
import {
  deleteCloudMessageOptimistically,
  editCloudMessageOptimistically,
  rollbackCloudMessageDelete,
  rollbackCloudMessageEdit,
} from '../src/features/cloud/cloudMessageMutations';
import {
  buildCloudMessageIndex,
  patchCanonicalCloudMessages,
} from '../src/features/cloud/cloudMessageIndex';
import type { CanonicalSessionState } from '../src/kordi-app/types';

const message = (overrides: Partial<CloudMessage>): CloudMessage => ({
  messageId: 'message-1',
  fromAccountId: 'acct_me',
  toAccountId: 'acct_peer',
  body: 'before',
  createdAt: '2026-08-31T10:00:00.000Z',
  deliveredAt: null,
  readAt: null,
  direction: 'outgoing',
  conversationId: 'conversation-1',
  version: 1,
  ...overrides,
});

test('message edits and deletes apply immediately, preserve envelopes, and roll back safely', () => {
  const direct = message({
    body: encodeCloudDirectMessageEnvelope({
      schemaVersion: 1,
      kind: 'message',
      text: 'before',
      targetCloudAgentName: 'Kordi',
    }),
  });
  const initial = { acct_peer: [direct] };
  const edit = {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    expectedVersion: 1,
    text: 'after',
  };
  const optimisticEditedAt = '2026-08-31T10:01:00.000Z';
  const edited = editCloudMessageOptimistically(initial, edit, optimisticEditedAt);
  const editedDirect = parseCloudDirectMessageEnvelope(edited.acct_peer![0]!.body);

  assert.equal(editedDirect?.text, 'after');
  assert.equal(editedDirect?.targetCloudAgentName, 'Kordi');
  assert.equal(edited.acct_peer![0]!.version, 2);
  assert.equal(edited.acct_peer![0]!.editedAt, optimisticEditedAt);
  assert.deepEqual(
    rollbackCloudMessageEdit(edited, initial, edit, optimisticEditedAt),
    initial,
  );

  const confirmed = {
    acct_peer: [{
      ...edited.acct_peer![0]!,
      editedAt: '2026-08-31T10:01:01.000Z',
    }],
  };
  assert.strictEqual(
    rollbackCloudMessageEdit(confirmed, initial, edit, optimisticEditedAt),
    confirmed,
  );

  const group = message({
    messageId: 'message-2',
    conversationId: 'conversation-2',
    sessionId: 'session:group:reaction',
    body: encodeCloudGroupControl({
      kind: 'group-message',
      groupId: 'session:group:reaction',
      groupTitle: 'Optimistic group',
      createdByAccountId: 'acct_me',
      actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      participants: [{ accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' }],
      message: {
        id: 'logical-message-2',
        senderAccountId: 'acct_me',
        text: 'before',
        createdAtMs: Date.parse('2026-08-31T10:00:00.000Z'),
        requestId: 'request-2',
      },
    }),
  });
  const groupEdit = editCloudMessageOptimistically(
    { acct_peer: [group] },
    {
      conversationId: 'conversation-2',
      messageId: 'message-2',
      expectedVersion: 1,
      text: 'after group edit',
    },
    optimisticEditedAt,
  );
  const editedGroup = parseCloudGroupControl(groupEdit.acct_peer![0]!.body);
  assert.equal(editedGroup?.message?.text, 'after group edit');
  assert.equal(editedGroup?.message?.requestId, 'request-2');
  const canonical: CanonicalSessionState = {
    profile: { id: 'profile:me', humanIdentityId: 'human:acct_me' },
    identities: [],
    sessions: [],
    participants: [],
    messages: [{
      id: 'logical-message-2',
      sessionId: 'session:group:reaction',
      senderIdentityId: 'human:acct_me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'before',
      contentHash: 'before',
      content: { cloudMessageVersion: 1, editedAt: null },
      createdAtMs: Date.parse('2026-08-31T10:00:00.000Z'),
      updatedAtMs: Date.parse('2026-08-31T10:00:00.000Z'),
      parentMessageId: null,
      status: 'received',
      sourceTransport: 'cloud-group',
      sourceEventId: 'cloud-group:message-2',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
  const projected = patchCanonicalCloudMessages(
    canonical,
    buildCloudMessageIndex('acct_me', groupEdit).groupRows,
  );
  assert.equal(projected?.messages[0]?.contentText, 'after group edit');
  assert.equal(projected?.messages[0]?.contentHash, null);
  assert.equal(projected?.messages[0]?.content.cloudMessageVersion, 2);
  assert.equal(projected?.messages[0]?.content.editedAt, optimisticEditedAt);

  const deleted = deleteCloudMessageOptimistically(initial, edit);
  assert.deepEqual(deleted.acct_peer, []);
  assert.deepEqual(rollbackCloudMessageDelete(deleted, initial, edit), initial);
});

test('successful message deletion durably removes the native projection', () => {
  const source = readFileSync(new URL('../src/app/useKordiMessageMutations.ts', import.meta.url), 'utf8');
  assert.match(source, /await deletion;[\s\S]*deleteCanonicalCloudMessage\(messageId\)/);
});

test('group agent terminal text and reactions never use the retained waiting-slot wire row', () => {
  const sessionId = 'session:group:agent-response';
  const stableId = 'msg:cloud-agent-processing:request:acct_me';
  const terminalId = 'msg:cloud-agent:terminal';
  const wire = (id: string, text: string, deliveryState: string) => message({
    messageId: `wire:${id}`, sessionId,
    reactions: [{ value: id === terminalId ? '👍' : '👎', accountIds: ['acct_peer'] }],
    body: encodeCloudGroupControl({
      kind: 'group-message', groupId: sessionId, groupTitle: 'Group',
      createdByAccountId: 'acct_me',
      actor: { accountId: 'acct_me', displayName: 'Owner', role: 'person' },
      participants: [{ accountId: 'acct_me', displayName: 'Owner', role: 'person' }],
      message: {
        id, text, deliveryState, senderAccountId: 'acct_me', senderKind: 'agent',
        requestId: 'request', createdAtMs: 1_000,
      },
    }),
  });
  const terminal = wire(terminalId, 'Final answer', 'complete');
  const state = {
    messages: [{
      id: stableId, sessionId, senderIdentityId: 'agent:cloud-agent:cloud-agent:acct_me',
      senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Final answer',
      content: { cloudGroupMessageId: terminalId, deliveryState: 'complete' },
      parentMessageId: 'request', status: 'received', sequenceNum: 2,
      createdAtMs: 1_000, updatedAtMs: 2_000, sourceTransport: 'cloud-group-agent',
    }],
  } as CanonicalSessionState;
  for (const oldText of ['', 'processing...']) {
    const waiting = wire(stableId, oldText, 'processing');
    const staleIndex = buildCloudMessageIndex('acct_peer', { acct_me: [waiting] });
    assert.equal(patchCanonicalCloudMessages(state, staleIndex.groupRows), state,
      'an absent terminal wire row must not fall back to the older waiting slot');
    for (const rows of [[waiting, terminal], [terminal, waiting]]) {
      const index = buildCloudMessageIndex('acct_peer', { acct_me: rows });
      const projected = patchCanonicalCloudMessages(state, index.groupRows)!;
      assert.equal(projected.messages[0]?.contentText, 'Final answer');
      assert.equal(projected.messages[0]?.content.cloudReactionTargetMessageId, `wire:${terminalId}`);
      assert.deepEqual(projected.messages[0]?.content.reactions,
        [{ value: '👍', accountIds: ['acct_peer'] }]);
    }
  }
});

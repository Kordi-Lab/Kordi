import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';
import { planInterruptedCloudSelfAgentTurns } from '../src/features/cloud/cloudSelfAgentInterruptedTurns';
import { CLOUD_SELF_AGENT_LOCAL_EXECUTION_WINDOW_MS } from '../src/features/cloud/cloudSelfAgentExecutionState';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';

const LOADED_AT_MS = 1_000_000;
const NOTE = 'Previous request was interrupted before an answer was produced because the desktop app was refreshed or restarted.';

function request(overrides: Partial<CanonicalSessionMessage> = {}) {
  return {
    id: 'local-request', sessionId: 'ask-agent', senderIdentityId: 'human:me', senderRole: 'user',
    messageKind: 'text', contentText: 'check the worktree status', status: 'sent', sequenceNum: 1,
    createdAtMs: LOADED_AT_MS - 60_000, updatedAtMs: LOADED_AT_MS - 60_000,
    sourceTransport: 'desktop-chat-ui', content: { desktopEntryId: 'wire-request' }, ...overrides,
  } as CanonicalSessionMessage;
}

function processing(parent: CanonicalSessionMessage, overrides: Partial<CanonicalSessionMessage> = {}) {
  return {
    id: `reply:${parent.id}`, sessionId: parent.sessionId, senderIdentityId: 'agent:me', senderRole: 'owned-agent',
    messageKind: 'agent-turn', contentText: '', status: 'processing', sequenceNum: parent.sequenceNum + 1,
    createdAtMs: parent.createdAtMs + 1, updatedAtMs: parent.createdAtMs + 1, sourceTransport: 'cloud-self-agent',
    sourceEventId: `wire-processing:${parent.id}`, parentMessageId: parent.id,
    content: {
      cloudRequestMessageId: parent.sourceTransport === 'cloud-self-agent' ? parent.sourceEventId : 'wire-request',
      deliveryState: 'processing', thinkingText: 'Checking current git worktree status',
    },
    ...overrides,
  } as CanonicalSessionMessage;
}

function state(messages: CanonicalSessionMessage[]) {
  return {
    sessions: [{ id: 'ask-agent', kind: 'self-agent', title: 'Check the worktree status', status: 'active' }],
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:me', kind: 'agent', displayName: 'babyshu', source: 'local', ownerIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 },
    ],
    participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [], storagePath: '/fixture/canonical',
    messages, profile: { humanIdentityId: 'human:me' },
  } as unknown as CanonicalSessionState;
}

function plan(messages: CanonicalSessionMessage[], options: { activeRequestIds?: Set<string>; nowMs?: number } = {}) {
  return planInterruptedCloudSelfAgentTurns({
    state: state(messages),
    attemptedRowIds: new Set(),
    activeRequestIds: options.activeRequestIds ?? new Set(),
    loadedAtMs: LOADED_AT_MS,
    nowMs: options.nowMs ?? LOADED_AT_MS + 1_000,
  });
}

test('a reply still processing for a request sent before this app loaded is closed in the native runtime', () => {
  const sent = request();
  const result = plan([sent, processing(sent)]);
  assert.deepEqual(result.nativeSessionIds, ['ask-agent']);
  assert.deepEqual(result.rowIds, [`reply:${sent.id}`]);
  assert.deepEqual(result.releaseRequests, []);
});

test('a turn this app is running is untouched', () => {
  const sent = request({ createdAtMs: LOADED_AT_MS + 10 });
  const result = plan([sent, processing(sent)]);
  assert.deepEqual(result, { rowIds: [], nativeSessionIds: [], releaseRequests: [] });
});

test('a reply whose request already has a terminal answer needs no recovery', () => {
  const sent = request();
  const note = { ...processing(sent), id: 'native-note', sourceTransport: 'desktop-chat', status: 'failed', contentText: NOTE, content: { deliveryState: 'failed', error: NOTE } } as CanonicalSessionMessage;
  const result = plan([sent, processing(sent), note]);
  assert.deepEqual(result.nativeSessionIds, []);
  assert.deepEqual(result.releaseRequests, []);
  assert.deepEqual(result.rowIds, [`reply:${sent.id}`], 'The covered row is not planned again');
});

test('a leased request from another device is released only after this app can no longer run it', () => {
  const remote = request({ id: 'remote-request', sourceTransport: 'cloud-self-agent', sourceEventId: 'wire-remote', content: {} });
  const rows = [remote, processing(remote)];
  const afterWindow = remote.createdAtMs + CLOUD_SELF_AGENT_LOCAL_EXECUTION_WINDOW_MS + 1;
  assert.deepEqual(plan(rows).releaseRequests, [], 'This app may still execute the request');
  assert.deepEqual(plan(rows, { nowMs: afterWindow }).releaseRequests, [{ sessionId: 'ask-agent', requestId: 'wire-remote' }]);
  assert.deepEqual(plan(rows, { nowMs: afterWindow, activeRequestIds: new Set(['wire-remote']) }).releaseRequests, [], 'A request this app started is never released');
  assert.deepEqual(plan(rows, { nowMs: afterWindow }).nativeSessionIds, [], 'Another device sent it, so this Mac adds no note');
});

test('the native note replaces the processing mirror in the transcript', () => {
  const sent = request();
  const stale = processing(sent);
  const before = createCanonicalSessionReadModel(state([sent, stale])).messages('ask-agent');
  assert.equal(before.at(-1)?.turn?.completed, false, 'Before recovery the reply reads as thinking');

  const note = {
    id: 'native-note', sessionId: 'ask-agent', senderIdentityId: 'agent:me', senderRole: 'owned-agent',
    messageKind: 'agent-turn', contentText: NOTE, status: 'failed', sequenceNum: 3,
    createdAtMs: LOADED_AT_MS + 5, updatedAtMs: LOADED_AT_MS + 5, sourceTransport: 'desktop-chat',
    sourceEventId: 'desktop:ask-agent:note', parentMessageId: sent.id,
    content: { deliveryState: 'failed', error: NOTE, desktopEntryId: 'note-entry' },
  } as CanonicalSessionMessage;
  const after = createCanonicalSessionReadModel(state([sent, stale, note])).messages('ask-agent');
  const replies = after.filter((message) => message.turn);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].turn?.completed, true);
  assert.equal(replies[0].turn?.status, 'failed');
  assert.equal(replies[0].turn?.error, NOTE);
});

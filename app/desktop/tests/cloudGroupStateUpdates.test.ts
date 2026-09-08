import assert from 'node:assert/strict';
import test from 'node:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionCatalog,
  CanonicalSessionMessage,
} from '../src/kordi-app/types';
import {
  applyCanonicalSessionStateAction,
  canonicalStateFromStore,
  createCanonicalStore,
  mergeCanonicalCatalog,
  mergeCanonicalMessagePage,
  mergeCanonicalStateIntoStore,
} from '../src/features/canonical/canonicalStore';
import { mergeCanonicalMessageRow } from '../src/features/canonical/canonicalStateReducers';
import { createCloudCanonicalStateUpdates } from '../src/features/cloud/cloudCanonicalStateUpdates';
import { applyCloudGroupMessageControl } from '../src/features/cloud/cloudGroupMessageControl';
import { removeCanonicalMessageById } from '../src/features/cloud/cloudAgentRequestState';
import { cleanCloudText, cloudObjectContent } from '../src/features/cloud/cloudValue';
import type {
  CanonicalSessionStateUpdate,
  CloudGroupControlContext,
} from '../src/features/cloud/cloudGroupControlContext';

const GROUP = 'session:group:one';
const OTHER = 'session:group:two';

function message(id: string, sessionId: string, sequenceNum: number): CanonicalSessionMessage {
  return {
    id, sessionId, sequenceNum, senderIdentityId: 'human:me', senderRole: 'user',
    messageKind: 'text', contentText: id, content: {}, status: 'sent',
    createdAtMs: sequenceNum, updatedAtMs: sequenceNum,
  };
}

function harness(ready: boolean) {
  const catalog: CanonicalSessionCatalog = {
    storagePath: '/tmp/canonical-fixture.sqlite',
    profile: {
      id: 'fixture', humanIdentityId: 'human:me', storageRoot: '/tmp',
      createdAtMs: 1, updatedAtMs: 1,
    },
    identities: [], participants: [], delegatedExchanges: [], presence: [],
    sessions: [GROUP, OTHER].map((id) => ({
      id, kind: 'group', title: id, status: 'active', createdByIdentityId: 'human:me',
      createdAtMs: 1, updatedAtMs: 1,
    })),
    summaries: [GROUP, OTHER].map((sessionId) => ({
      sessionId, messageCount: 1, contextSnapshotCount: 0,
      latestMessage: message(`${sessionId}:before`, sessionId, 1),
    })),
  };
  let store = mergeCanonicalCatalog(createCanonicalStore(), catalog);
  const mergeRows = (rows: CanonicalSessionMessage[]) => {
    if (!ready) {
      const current = canonicalStateFromStore(store)!;
      store = mergeCanonicalStateIntoStore(store, {
        ...current, messages: [...current.messages, ...rows],
      });
      return;
    }
    for (const sessionId of new Set(rows.map((row) => row.sessionId))) {
      const messages = rows.filter((row) => row.sessionId === sessionId);
      store = mergeCanonicalMessagePage(store, {
        sessionId, messages, hasOlder: false,
        oldestSequenceNum: Math.min(...messages.map((row) => row.sequenceNum)),
        newestSequenceNum: Math.max(...messages.map((row) => row.sequenceNum)),
      });
    }
  };
  if (ready) mergeRows(canonicalStateFromStore(store)!.messages);
  const stateRef = { current: canonicalStateFromStore(store) };
  const buffer = createCloudCanonicalStateUpdates('fixture-account');
  const publish = (update: CanonicalSessionStateUpdate) => {
    if (!buffer.isActive()) return;
    stateRef.current = update(stateRef.current);
    buffer.publish(update);
  };
  const flush = () => buffer.flush((update) => {
    store = applyCanonicalSessionStateAction(store, update);
  });
  return { get store() { return store; }, stateRef, buffer, publish, flush, mergeRows };
}

function context(h: ReturnType<typeof harness>, groupId: string, id: string): CloudGroupControlContext {
  const state = h.stateRef.current!;
  const actor = { accountId: 'peer', displayName: 'Peer', avatarUrl: null, role: 'person' as const };
  return {
    account: { accountId: 'me' } as CloudGroupControlContext['account'],
    cloudMessage: {
      messageId: `wire:${id}`, fromAccountId: 'peer', toAccountId: 'me',
      body: '', createdAt: '2026-01-01T00:00:00Z', deliveredAt: null, readAt: null,
      direction: 'incoming', sessionId: groupId, version: 1, conversationSequence: 4,
    },
    envelope: {
      kind: 'group-message', groupId, groupTitle: 'Shared group', createdByAccountId: 'me',
      actor, participants: [actor],
      message: {
        id, senderAccountId: 'peer', senderKind: 'human', text: id, createdAtMs: 4,
        ...(groupId === GROUP ? { messageAction: {
          schemaVersion: 1 as const, kind: 'quote' as const,
          source: {
            sourceSessionId: GROUP, sourceMessageId: 'request', senderLabel: 'Me',
            textPreview: 'Question', attachmentCount: 0,
          },
        } } : {}),
      },
    },
    canonicalState: state, nextState: state, localHumanIdentityId: 'human:me',
    groupSpaceId: groupId, participantByAccount: new Map([['peer', actor]]),
    identityIdByAccount: new Map([['peer', 'human:peer']]),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function unexpectedAgentBranch(): never {
  throw new Error('The human-message regression must not enter agent-only branches');
}

const stateOps = {
  objectContent: cloudObjectContent, cleanText: cleanCloudText,
  upsertIdentity: unexpectedAgentBranch, processingSlot: unexpectedAgentBranch,
  incomingAlreadyApplied: unexpectedAgentBranch, removeOfflinePlaceholder: unexpectedAgentBranch,
  removeTimeoutPlaceholder: unexpectedAgentBranch, removePendingRows: unexpectedAgentBranch,
  removeMessage: removeCanonicalMessageById, isProcessingPlaceholder: unexpectedAgentBranch,
};

for (const ready of [false, true]) {
  test(`async group workers preserve concurrent rows and quote targets in ${ready ? 'ready' : 'cold'} stores`, async () => {
    const h = harness(ready);
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    const gates = new Map(['slow-reply', 'fast-other'].map((id) => [id, {
      entered: deferred(), release: deferred(),
    }]));
    mockIPC(async (command, payload) => {
      assert.equal(command, 'desktop_canonical_upsert_message_fast');
      const request = payload?.request as AppendCanonicalMessageRequest;
      const gate = gates.get(request.id!);
      assert.ok(gate);
      gate.entered.resolve();
      await gate.release.promise;
      return { ...message(request.id!, request.sessionId, 4), ...request, sequenceNum: 4, updatedAtMs: 4 };
    });
    try {
      const slow = applyCloudGroupMessageControl({
        context: context(h, GROUP, 'slow-reply'), setCanonicalState: h.publish, stateOps,
      });
      const fast = applyCloudGroupMessageControl({
        context: context(h, OTHER, 'fast-other'), setCanonicalState: h.publish, stateOps,
      });
      await Promise.all([...gates.values()].map((gate) => gate.entered.promise));
      h.mergeRows([
        message('request', GROUP, 2), message('live', GROUP, 3), message('other-live', OTHER, 2),
      ]);
      assert.equal(h.stateRef.current!.messages.some((row) => row.id === 'request'), false);
      assert.equal(h.store.hydrationBySessionId[GROUP], ready ? 'ready' : 'cold');
      gates.get('fast-other')!.release.resolve();
      await fast;
      h.flush();
      gates.get('slow-reply')!.release.resolve();
      await slow;
      h.flush();

      assert.deepEqual(h.store.messagesBySessionId[GROUP].map((row) => row.id), [
        `${GROUP}:before`, 'request', 'live', 'slow-reply',
      ]);
      assert.deepEqual(h.store.messagesBySessionId[OTHER].map((row) => row.id), [
        `${OTHER}:before`, 'other-live', 'fast-other',
      ]);
      const reply = h.store.messagesBySessionId[GROUP].find((row) => row.id === 'slow-reply')!;
      assert.equal(reply.parentMessageId, 'request');
      assert.equal(cloudObjectContent(reply.content).replyToMessageId, 'request');
      const settled = h.store;
      h.flush();
      assert.equal(h.store, settled, 'empty repeated flush must be a no-op');
    } finally {
      for (const gate of gates.values()) gate.release.resolve();
      h.buffer.dispose();
      clearMocks();
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}

test('explicit placeholder removal does not delete concurrent transcript rows', () => {
  const h = harness(true);
  h.mergeRows([message('placeholder', GROUP, 2), message('request', GROUP, 3)]);
  h.stateRef.current = canonicalStateFromStore(h.store);
  h.publish((current) => removeCanonicalMessageById(current, 'placeholder'));
  h.mergeRows([message('live', GROUP, 4), message('other-live', OTHER, 2)]);
  h.flush();
  assert.deepEqual(h.store.messagesBySessionId[GROUP].map((row) => row.id), [
    `${GROUP}:before`, 'request', 'live',
  ]);
  assert.ok(h.store.messagesBySessionId[OTHER].some((row) => row.id === 'other-live'));
  const settled = h.store;
  h.flush();
  assert.equal(h.store, settled);
});

test('disposed queues ignore pending, late, and already-scheduled flush operations', () => {
  const h = harness(true);
  const initial = h.store;
  let scheduled: CanonicalSessionStateUpdate | undefined;
  h.buffer.publish((current) => mergeCanonicalMessageRow(current, message('old-account', GROUP, 2)));
  h.buffer.flush((update) => { scheduled = update; });
  assert.ok(scheduled);
  h.buffer.publish((current) => mergeCanonicalMessageRow(current, message('pending', GROUP, 3)));
  h.buffer.dispose();
  h.buffer.publish((current) => mergeCanonicalMessageRow(current, message('late', GROUP, 3)));
  h.flush();
  assert.equal(h.store, initial);
  assert.equal(applyCanonicalSessionStateAction(h.store, scheduled), initial);
  h.buffer.activate();
  assert.equal(applyCanonicalSessionStateAction(h.store, scheduled), initial, 'reactivation must not revive an old flush');
  h.publish((current) => mergeCanonicalMessageRow(current, message('reactivated', GROUP, 4)));
  h.flush();
  assert.deepEqual(h.store.messagesBySessionId[GROUP].map((row) => row.id), [`${GROUP}:before`, 'reactivated']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '../src/kordi-app/types';
import { mergeCanonicalMessageRow } from '../src/features/canonical/canonicalStateReducers';
import { applyCloudGroupMessageControl } from '../src/features/cloud/cloudGroupMessageControl';
import type { CloudGroupControlContext } from '../src/features/cloud/cloudGroupControlContext';
import {
  isCloudAgentProcessingPlaceholderText,
  removeCanonicalMessageById,
  removeCloudGroupOfflinePlaceholder,
  removeCloudGroupPendingRowsForTerminalResponse,
  removeCloudGroupTimeoutPlaceholderForTerminalResponse,
} from '../src/features/cloud/cloudAgentRequestState';
import { upsertCanonicalIdentityIntoLocalState } from '../src/features/cloud/cloudCanonicalStateMerge';
import {
  cloudGroupAgentProcessingSlotForResponse,
  cloudGroupIncomingMessageAlreadyApplied,
} from '../src/features/cloud/useCloudGroupControlApplication';
import { cleanCloudText, cloudObjectContent } from '../src/features/cloud/cloudValue';
import { nativeUpsert } from './visual/transcriptOpenSettleReplay';

const GROUP = 'session:group:one';
const ME = 'acct-owner';
const PARENT_SLOT = `msg:cloud-agent-processing:request:${ME}`;
const SHORT = 'Starting the task now. I will share the finished file here when it is ready.';
const LONG = `The summary is ready.\n\n${Array.from({ length: 12 }, (_, index) => `- Topic ${index + 1}`).join('\n')}`;

const stateOps = {
  objectContent: cloudObjectContent,
  cleanText: cleanCloudText,
  upsertIdentity: upsertCanonicalIdentityIntoLocalState,
  processingSlot: cloudGroupAgentProcessingSlotForResponse,
  incomingAlreadyApplied: cloudGroupIncomingMessageAlreadyApplied,
  removeOfflinePlaceholder: removeCloudGroupOfflinePlaceholder,
  removeTimeoutPlaceholder: removeCloudGroupTimeoutPlaceholderForTerminalResponse,
  removePendingRows: removeCloudGroupPendingRowsForTerminalResponse,
  removeMessage: removeCanonicalMessageById,
  isProcessingPlaceholder: isCloudAgentProcessingPlaceholderText,
};

function initialState(messages: CanonicalSessionMessage[] = []): CanonicalSessionState {
  return {
    storagePath: '/tmp/canonical-fixture.sqlite',
    profile: { id: 'fixture', humanIdentityId: 'human:me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    identities: [], participants: [], delegatedExchanges: [], presence: [],
    sessions: [{ id: GROUP, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 }],
    messages: [
      {
        id: 'request', sessionId: GROUP, sequenceNum: 1, senderIdentityId: 'human:me', senderRole: 'user',
        messageKind: 'text', contentText: '@agent do it again', content: {}, status: 'sent', createdAtMs: 1, updatedAtMs: 1,
      },
      ...messages,
    ],
    contextSnapshots: [],
  } as unknown as CanonicalSessionState;
}

// Mirrors cloudGroupAgentPublication: the parent reply and its background
// follow-up both reply to the original request, with distinct request ids.
const parentWire = { id: 'msg:cloud-agent:turn-parent', requestId: 'request', text: SHORT, createdAtMs: 10, tools: true };
const followUpWire = { id: 'msg:cloud-agent:turn-follow-up', requestId: 'follow-up-1', text: LONG, createdAtMs: 20, tools: false };

function context(state: CanonicalSessionState, wire: typeof parentWire, sequence: number): CloudGroupControlContext {
  const owner = { accountId: ME, displayName: 'Owner', avatarUrl: null, role: 'person' as const };
  return {
    account: { accountId: ME } as CloudGroupControlContext['account'],
    cloudMessage: {
      messageId: `wire:${wire.id}`, fromAccountId: ME, toAccountId: ME,
      body: '', createdAt: '2026-01-01T00:00:00Z', deliveredAt: null, readAt: null,
      direction: 'outgoing', sessionId: GROUP, version: 1, conversationSequence: sequence,
    },
    envelope: {
      kind: 'group-message', groupId: GROUP, groupTitle: 'Group', createdByAccountId: ME,
      actor: owner, participants: [owner],
      message: {
        id: wire.id, senderAccountId: ME, senderAgentId: 'agent-one', senderKind: 'agent',
        senderDisplayName: 'Agent', text: wire.text, createdAtMs: wire.createdAtMs,
        deliveryState: 'complete', replyToMessageId: 'request', requestId: wire.requestId,
        structuredContent: wire.tools ? { tools: [{
          id: 'background-session:bg-1', name: 'task_operator', status: 'completed', arguments: '{}', liveOutput: '',
          resultText: 'Background session: {"sessionId":"bg-1","title":"Task"}', isError: false,
        }] } : null,
      },
    },
    canonicalState: state, nextState: state, localHumanIdentityId: 'human:me',
    groupSpaceId: GROUP, participantByAccount: new Map([[ME, owner]]),
    identityIdByAccount: new Map([[ME, 'human:me']]),
  } as CloudGroupControlContext;
}

async function replay(start: CanonicalSessionState, wires: Array<[typeof parentWire, number]>) {
  let state = start;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  let sequence = 100;
  mockIPC(async (command, payload) => {
    if (command === 'desktop_canonical_upsert_identity_fast') {
      const request = payload?.request as { id: string };
      return { ...request, createdAtMs: 1, updatedAtMs: 1 };
    }
    assert.equal(command, 'desktop_canonical_upsert_message_fast');
    const request = payload?.request as AppendCanonicalMessageRequest;
    const existing = state.messages.find((row) => row.id === request.id);
    sequence += 1;
    return { ...nativeUpsert(existing, request), sequenceNum: existing?.sequenceNum ?? sequence, createdAtMs: request.createdAtMs ?? 1, updatedAtMs: sequence };
  });
  try {
    for (const [wire, conversationSequence] of wires) {
      const result = await applyCloudGroupMessageControl({
        context: context(state, wire, conversationSequence),
        setCanonicalState: (update) => { state = update(state) ?? state; },
        stateOps,
      });
      if (result) state = result.nextState;
    }
  } finally {
    clearMocks();
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  return state;
}

function agentRows(state: CanonicalSessionState) {
  return state.messages.filter((row) => row.senderRole !== 'user').map((row) => ({ id: row.id, text: row.contentText }));
}

test('a background follow-up gets its own row instead of overwriting the parent reply', async () => {
  const once = await replay(initialState(), [[parentWire, 2], [followUpWire, 3]]);
  const parent = agentRows(once).find((row) => row.id === PARENT_SLOT);
  assert.equal(parent?.text, SHORT, 'the follow-up must not replace the parent reply text');
  assert.ok(agentRows(once).some((row) => row.id !== PARENT_SLOT && row.text === LONG), 'the follow-up keeps its own row');

  // Opening the group replays the same wire rows again; nothing may flip.
  const again = await replay(once, [[followUpWire, 3], [parentWire, 2], [followUpWire, 3]]);
  assert.deepEqual(agentRows(again), agentRows(once));
  const followUp = again.messages.find((row) => row.contentText === LONG)!;
  assert.equal(followUp.parentMessageId, 'request');
  assert.equal(cloudObjectContent(followUp.content).replyToMessageId, 'request');
});

test('a parent slot that already absorbed a follow-up is repaired by replay', async () => {
  const collided = mergeCanonicalMessageRow(initialState(), {
    id: PARENT_SLOT, sessionId: GROUP, sequenceNum: 2, senderIdentityId: 'agent:cloud-agent:agent-one',
    senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: LONG,
    content: { deliveryState: 'complete', requestId: 'request', replyToMessageId: 'request', cloudGroupMessageId: followUpWire.id, senderOwnerAccountId: ME, conversationSequence: 3, cloudMessageVersion: 1 },
    parentMessageId: 'request', status: 'complete', createdAtMs: 10, updatedAtMs: 10,
    sourceTransport: 'cloud-group-agent', sourceEventId: `cloud-group-agent:wire:${followUpWire.id}`,
  })!;
  const repaired = await replay(collided, [[parentWire, 2], [followUpWire, 3], [parentWire, 2], [followUpWire, 3]]);
  assert.equal(repaired.messages.find((row) => row.id === PARENT_SLOT)?.contentText, SHORT);
  assert.equal(repaired.messages.filter((row) => row.contentText === LONG).length, 1);
  assert.notEqual(repaired.messages.find((row) => row.contentText === LONG)?.id, PARENT_SLOT);
});

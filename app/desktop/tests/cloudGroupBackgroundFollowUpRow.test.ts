import assert from 'node:assert/strict';
import test from 'node:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionCatalog,
  CanonicalSessionMessage,
  CanonicalSessionState,
  UpsertCanonicalIdentityRequest,
} from '../src/kordi-app/types';
import {
  canonicalStateFromStore,
  createCanonicalStore,
  mergeCanonicalCatalog,
} from '../src/features/canonical/canonicalStore';
import { applyCloudGroupMessageControl } from '../src/features/cloud/cloudGroupMessageControl';
import { publishCloudGroupAgentTerminalAfterGuards } from '../src/features/cloud/cloudGroupAgentPublication';
import { parseCloudGroupControl, type CloudGroupControlEnvelope } from '../src/features/cloud/cloudGroupMessages';
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
import type {
  CloudGroupControlContext,
  CloudGroupMessageControlContext,
} from '../src/features/cloud/cloudGroupControlContext';

const GROUP = 'session:group:one';
const OWNER = 'acct_owner';
const PEER = 'acct_peer';
const PROCESSING_ID = `msg:cloud-agent-processing:request:${OWNER}`;

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

function row(overrides: Partial<CanonicalSessionMessage> & Pick<CanonicalSessionMessage, 'id'>): CanonicalSessionMessage {
  return {
    sessionId: GROUP, sequenceNum: 1, senderIdentityId: `human:${OWNER}`, senderRole: 'user',
    messageKind: 'text', contentText: overrides.id, content: {}, status: 'sent',
    createdAtMs: 1, updatedAtMs: 1, ...overrides,
  };
}

function initialState(localAccountId: string): CanonicalSessionState {
  const catalog: CanonicalSessionCatalog = {
    storagePath: '/tmp/canonical-fixture.sqlite',
    profile: {
      id: 'fixture', humanIdentityId: `human:${localAccountId}`, storageRoot: '/tmp',
      createdAtMs: 1, updatedAtMs: 1,
    },
    identities: [], participants: [], delegatedExchanges: [], presence: [],
    sessions: [{
      id: GROUP, kind: 'group', title: 'Group', status: 'active', createdByIdentityId: `human:${OWNER}`,
      createdAtMs: 1, updatedAtMs: 1,
    }],
    summaries: [],
  };
  const state = canonicalStateFromStore(mergeCanonicalCatalog(createCanonicalStore(), catalog))!;
  const messages = [row({ id: 'request', contentText: 'Please investigate' })];
  if (localAccountId === OWNER) {
    // The owner's Mac shows its own processing slot while the agent works.
    messages.push(row({
      id: PROCESSING_ID, sequenceNum: 2, senderIdentityId: `agent:cloud:${OWNER}`,
      senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: '',
      content: {
        senderOwnerAccountId: OWNER, deliveryState: 'processing',
        requestId: 'request', replyToMessageId: 'request',
      },
      status: 'processing', parentMessageId: 'request', createdAtMs: 2,
      sourceTransport: 'cloud-group-agent', sourceEventId: `cloud-group-agent:${PROCESSING_ID}`,
    }));
  }
  return { ...state, messages };
}

type AgentReply = NonNullable<CloudGroupControlEnvelope['message']>;

function agentReply(overrides: Partial<AgentReply> & Pick<AgentReply, 'id' | 'text'>): AgentReply {
  return {
    senderAccountId: OWNER, senderAgentId: 'kordi', senderKind: 'agent',
    senderDisplayName: 'Kordi', deliveryState: 'complete', createdAtMs: 10,
    replyToMessageId: 'request', requestId: 'request', ...overrides,
  };
}

function context(
  state: CanonicalSessionState,
  localAccountId: string,
  message: AgentReply,
  sequence: number,
  version = 1,
): CloudGroupControlContext {
  const participant = (accountId: string) => ({
    accountId, displayName: accountId, avatarUrl: null, role: 'person' as const,
  });
  return {
    account: { accountId: localAccountId } as CloudGroupControlContext['account'],
    cloudMessage: {
      messageId: `wire:${message.id}`, fromAccountId: OWNER, toAccountId: localAccountId,
      body: '', createdAt: '2026-01-01T00:00:00Z', deliveredAt: null, readAt: null,
      direction: localAccountId === OWNER ? 'outgoing' : 'incoming',
      sessionId: GROUP, version, conversationSequence: sequence,
    },
    envelope: {
      kind: 'group-message', groupId: GROUP, groupTitle: 'Group', createdByAccountId: OWNER,
      actor: participant(OWNER), participants: [participant(OWNER), participant(PEER)], message,
    },
    canonicalState: state, nextState: state, localHumanIdentityId: `human:${localAccountId}`,
    groupSpaceId: GROUP,
    participantByAccount: new Map([[OWNER, participant(OWNER)], [PEER, participant(PEER)]]),
    identityIdByAccount: new Map([[OWNER, `human:${OWNER}`], [PEER, `human:${PEER}`]]),
  };
}

async function withCanonicalIpc<T>(run: () => Promise<T>): Promise<T> {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  let sequence = 10;
  mockIPC((command, payload) => {
    if (command === 'desktop_canonical_upsert_identity_fast') {
      const request = payload?.request as UpsertCanonicalIdentityRequest;
      return { ...request, createdAtMs: 1, updatedAtMs: 1 };
    }
    assert.equal(command, 'desktop_canonical_upsert_message_fast');
    const request = payload?.request as AppendCanonicalMessageRequest;
    sequence += 1;
    return { ...request, sequenceNum: sequence, updatedAtMs: sequence, contentHash: null };
  });
  try {
    return await run();
  } finally {
    clearMocks();
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

async function apply(state: CanonicalSessionState, localAccountId: string, message: AgentReply, sequence: number, version = 1) {
  let current: CanonicalSessionState | null = state;
  const result: CloudGroupMessageControlContext | null = await applyCloudGroupMessageControl({
    context: context(state, localAccountId, message, sequence, version),
    setCanonicalState: (update) => { current = update(current); },
    stateOps,
  });
  assert.ok(result);
  return current!;
}

const parentReply = agentReply({
  id: 'msg:cloud-agent:turn-parent', text: 'I started an investigation.', createdAtMs: 10,
  structuredContent: { startedAtMs: 2_000, completedAtMs: 20_000 },
});
const followUpReply = agentReply({
  id: 'msg:cloud-agent:turn-follow-up', text: 'The investigation found the cause.', createdAtMs: 60,
  requestId: 'background-result:session-1', structuredContent: { startedAtMs: 50_000, completedAtMs: 58_000 },
});

function agentRows(state: CanonicalSessionState) {
  return state.messages.filter((message) => message.messageKind === 'agent-turn');
}

for (const localAccountId of [OWNER, PEER]) {
  const label = localAccountId === OWNER ? "the owner's Mac" : "another member's client";

  test(`a background follow-up gets its own row on ${label}`, async () => {
    await withCanonicalIpc(async () => {
      const afterParent = await apply(initialState(localAccountId), localAccountId, parentReply, 5);
      // The terminal reply still replaces the processing slot in place.
      assert.deepEqual(agentRows(afterParent).map((message) => message.id), [PROCESSING_ID]);
      const parent = agentRows(afterParent)[0];
      assert.equal(parent.contentText, 'I started an investigation.');
      assert.equal(parent.status, 'received');

      const afterFollowUp = await apply(afterParent, localAccountId, followUpReply, 6);
      const rows = agentRows(afterFollowUp);
      assert.equal(rows.length, 2);
      const [unchangedParent, followUp] = rows;
      assert.equal(unchangedParent.id, PROCESSING_ID);
      assert.equal(unchangedParent.contentText, 'I started an investigation.');
      assert.equal(cloudObjectContent(unchangedParent.content).requestId, 'request');
      assert.equal(cloudObjectContent(unchangedParent.content).startedAtMs, 2_000);
      assert.equal(cloudObjectContent(unchangedParent.content).completedAtMs, 20_000);

      assert.notEqual(followUp.id, PROCESSING_ID);
      assert.equal(followUp.contentText, 'The investigation found the cause.');
      assert.equal(followUp.parentMessageId, 'request');
      const followUpContent = cloudObjectContent(followUp.content);
      assert.equal(followUpContent.requestId, 'background-result:session-1');
      assert.equal(followUpContent.replyToMessageId, 'request');
      assert.equal(followUpContent.startedAtMs, 50_000);
      assert.equal(followUpContent.completedAtMs, 58_000);
    });
  });
}

test('a replayed follow-up stays in its own row', async () => {
  await withCanonicalIpc(async () => {
    const afterParent = await apply(initialState(OWNER), OWNER, parentReply, 5);
    const afterFollowUp = await apply(afterParent, OWNER, followUpReply, 6);
    const replayed = await apply(afterFollowUp, OWNER, followUpReply, 6);
    assert.deepEqual(
      agentRows(replayed).map((message) => message.contentText),
      ['I started an investigation.', 'The investigation found the cause.'],
    );
  });
});

test('a follow-up publication carries its own request id and turn timing', async () => {
  const bodies: string[] = [];
  const state = initialState(OWNER);
  const requestContext = context(state, OWNER, agentReply({ id: 'request', text: 'Please investigate' }), 1);
  await publishCloudGroupAgentTerminalAfterGuards({
    context: {
      ...requestContext,
      account: {
        accountId: OWNER, displayName: 'Owner', defaultAgent: null,
        avatar: { source: 'uploaded', uploadedAsset: null },
      } as unknown as CloudGroupControlContext['account'],
      senderIsAgent: false,
      mappedAttachments: [],
    },
    runtime: { mergeMessage: () => undefined, syncDiff: async () => undefined } as never,
    policy: {} as never,
    token: 'token',
    targetAccountIds: [PEER],
    responseMessageId: 'msg:cloud-agent:turn-follow-up',
    responseCreatedAtMs: 58_000,
    responseText: 'The investigation found the cause.',
    responseDeliveryState: 'complete',
    responseTools: [],
    responseTiming: { startedAtMs: 50_000, completedAtMs: 58_000 },
    requestId: 'background-result:session-1',
    agentId: 'kordi',
    agentDisplayName: 'Kordi',
    agentHandoff: null,
    signal: new AbortController().signal,
    publisher: {
      sendMessage: async (_token: string, _to: string, body: string) => {
        bodies.push(body);
        return { messageId: 'wire:follow-up' } as never;
      },
    },
  });
  assert.equal(bodies.length, 1);
  const message = parseCloudGroupControl(bodies[0])?.message;
  assert.equal(message?.requestId, 'background-result:session-1');
  assert.equal(message?.replyToMessageId, 'request');
  assert.deepEqual(message?.structuredContent, { startedAtMs: 50_000, completedAtMs: 58_000 });
});

for (const localAccountId of [OWNER, PEER]) {
  test(`cold group revisions share one durable reply ID for ${localAccountId}`, async () => {
    await withCanonicalIpc(async () => {
      const cold = { ...initialState(localAccountId), messages: [] };
      const waiting = agentReply({ id: 'cloud-reply', text: '', deliveryState: 'processing' });
      const pending = agentRows(await apply(cold, localAccountId, waiting, 17))[0];
      // The group page was unloaded when the completion arrived. Persistence
      // must still update the same primary key, independent of loaded rows.
      const finished = agentReply({ ...waiting, text: '8 + 5 = 13', deliveryState: 'complete' });
      const complete = agentRows(await apply(cold, localAccountId, finished, 17, 2))[0];
      assert.equal(pending.id, PROCESSING_ID);
      assert.equal(complete.id, pending.id);
      assert.equal(cloudObjectContent(pending.content).cloudGroupMessageId, 'cloud-reply');
      assert.equal(cloudObjectContent(complete.content).cloudGroupMessageId, 'cloud-reply');
      assert.notEqual(complete.sourceEventId, pending.sourceEventId);
      const durableRows = new Map([pending, complete].map((message) => [message.id, message]));
      assert.equal(durableRows.size, 1);
      assert.equal(durableRows.get(PROCESSING_ID)?.contentText, '8 + 5 = 13');
      let restored: CanonicalSessionState | null = { ...cold, messages: [...durableRows.values()] };
      const original = restored;
      const staleReplay = await applyCloudGroupMessageControl({
        context: context(restored, localAccountId, waiting, 17, 3),
        setCanonicalState: (update) => { restored = update(restored); },
        stateOps,
      });
      assert.equal(staleReplay, null);
      assert.deepEqual(restored?.messages, original.messages, 'pending replay cannot reopen a terminal slot');
    });
  });
}

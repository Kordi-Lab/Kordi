import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudAuthClient } from '../src/features/cloud/authClient';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import type { CloudAgentDefinition } from '../src/features/cloud/cloudAgents';
import {
  notifyDocumentAgentRequests,
  parseDocumentAgentRequest,
  runDocumentAgentRequest,
  setDocumentAgentRequestHandler,
  type DocumentAgentRequest,
  type DocumentAgentRuntime,
} from '../src/features/documents/documentAgentRequests';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const ACCOUNT = 'acct_example';
const REQUEST: DocumentAgentRequest = {
  runRequestId: 'doccmt:doccmt_example',
  commentId: 'doccmt_example',
  attachmentId: 'att_example',
  sessionId: 'group-example',
  requesterAccountId: 'acct_priya',
  agentId: `cloud-agent:${ACCOUNT}`,
  prompt: 'Request from Priya:\n@Kordi shorter please',
};

function turn(overrides: Partial<DesktopChatTurnSnapshot> = {}): DesktopChatTurnSnapshot {
  return {
    id: 'turn-1', sessionId: 'runtime', prompt: REQUEST.prompt, status: 'completed', message: '',
    assistantText: '  Shorter now.  ', thinkingText: '', tools: [], completed: true, succeeded: true,
    startedAtMs: 1, completedAtMs: 2, error: null, transcriptRefreshRequired: false,
    ...overrides,
  } as DesktopChatTurnSnapshot;
}

type Call = { action: string; input: Record<string, unknown> };

function harness(options: {
  acquired?: boolean;
  start?: () => Promise<DesktopChatTurnSnapshot>;
  progress?: () => unknown;
  definitions?: Record<string, CloudAgentDefinition>;
} = {}) {
  const calls: Call[] = [];
  const starts: unknown[][] = [];
  const warnings: string[] = [];
  const client = {
    desktopAgentExecution: async (_token: string, action: string, input: Record<string, unknown>) => {
      calls.push({ action, input });
      if (action === 'claim') {
        return {
          acquired: options.acquired ?? true,
          runId: 'run_1',
          contextSessionId: REQUEST.sessionId,
          turnIdentity: { ownerAccountId: input.ownerAccountId, requesterAccountId: input.requesterAccountId },
          connectorTools: [{ connectorId: 'kordi-documents', provider: 'kordi_documents', name: 'read_document', group: 'read' }],
        };
      }
      if (action.endsWith('/admit')) return { admitted: true };
      if (action.endsWith('/progress')) return options.progress?.() ?? {};
      return {};
    },
  } as unknown as Pick<CloudAuthClient, 'desktopAgentExecution'>;
  const runtime: DocumentAgentRuntime = {
    accountId: ACCOUNT,
    client,
    agentDefinitionsById: options.definitions ?? {},
    defaultRoute: { model: 'example-model', authProvider: 'example' },
    reportWarning: (message) => { warnings.push(message); },
    loadToken: async () => 'fixture-token',
    startTurn: async (...args) => {
      starts.push(args);
      return (options.start ?? (async () => turn()))();
    },
    waitForTurn: async () => turn(),
    cancelTurn: async () => undefined,
  };
  const actions = () => calls.map((call) => call.action);
  const published = () => calls
    .filter((call) => call.action.endsWith('/progress'))
    .map((call) => parseCloudAgentResponse(String(call.input.body)));
  return { runtime, calls, starts, warnings, actions, published };
}

test('a comment request is claimed once, run with the chat agent, and completed', async () => {
  const h = harness();
  const started = new Set<string>();
  const seen: Promise<string>[] = [];
  setDocumentAgentRequestHandler((request) => { seen.push(runDocumentAgentRequest(request, h.runtime, started)); });
  try {
    const event = { eventType: 'document.agent_request', payload: REQUEST };
    // The event is delivered twice, next to events this handler does not own.
    notifyDocumentAgentRequests([event, { eventType: 'document.updated', payload: REQUEST }, event]);
    notifyDocumentAgentRequests([{ eventType: 'document.agent_request', payload: { ...REQUEST, prompt: '' } }]);
    assert.deepEqual(await Promise.all(seen), ['completed', 'duplicate']);
  } finally { setDocumentAgentRequestHandler(null); }

  assert.deepEqual(h.actions(), ['claim', 'run_1/admit', 'run_1/progress']);
  const claim = h.calls[0].input;
  assert.equal(claim.requestMessageId, REQUEST.runRequestId);
  assert.equal(claim.sessionId, REQUEST.sessionId);
  assert.equal(claim.ownerAccountId, ACCOUNT);
  assert.equal(claim.requesterAccountId, 'acct_priya');
  assert.equal(claim.prompt, REQUEST.prompt);
  assert.deepEqual(claim.runtimeRoute, { defaultModel: 'example-model', defaultAuthProvider: 'example', defaultAuthChoice: undefined, thinking: undefined });

  // One local turn, in a runtime session of its own, with the lease identity and tools.
  assert.equal(h.starts.length, 1);
  const [requestId, runtimeSessionId, prompt, attachments, route, context, , contextSessionId] = h.starts[0] as [string, string, string, string[], { model?: string }, Array<{ contextRole?: string; executionLease?: { runId: string; connectorTools?: unknown[] } }>, unknown, string];
  assert.equal(requestId, REQUEST.runRequestId);
  assert.ok(runtimeSessionId.endsWith(`:request:${REQUEST.runRequestId}`), runtimeSessionId);
  assert.ok(runtimeSessionId.includes(ACCOUNT) && runtimeSessionId.includes(REQUEST.sessionId), runtimeSessionId);
  assert.equal(prompt, REQUEST.prompt);
  assert.deepEqual(attachments, []);
  assert.equal(route.model, 'example-model');
  assert.equal(contextSessionId, REQUEST.sessionId);
  const identity = context.at(-1)!;
  assert.equal(identity.contextRole, 'runtimeIdentity');
  assert.equal(identity.executionLease?.runId, 'run_1');
  assert.equal(identity.executionLease?.connectorTools?.length, 1);

  assert.deepEqual(h.published(), [{ kind: 'agent-response', requestId: REQUEST.runRequestId, text: 'Shorter now.', deliveryState: 'complete' }]);
  assert.equal(h.calls[2].input.claimId, claim.claimId);
  assert.deepEqual(h.warnings, []);
});

test('requests wait for the handler, and malformed payloads are dropped', async () => {
  assert.equal(parseDocumentAgentRequest({ ...REQUEST, runRequestId: 'msg_example' }), null);
  assert.equal(parseDocumentAgentRequest({ ...REQUEST, agentId: 7 }), null);
  assert.equal(parseDocumentAgentRequest(null), null);
  assert.deepEqual(parseDocumentAgentRequest({ ...REQUEST, extra: true }), REQUEST);
  notifyDocumentAgentRequests([{ eventType: 'document.agent_request', payload: REQUEST }]);
  const delivered: DocumentAgentRequest[] = [];
  setDocumentAgentRequestHandler((request) => { delivered.push(request); });
  setDocumentAgentRequestHandler(null);
  setDocumentAgentRequestHandler((request) => { delivered.push(request); });
  setDocumentAgentRequestHandler(null);
  assert.deepEqual(delivered, [REQUEST]);
});

test('requests for agents of other accounts are ignored', async () => {
  const theirs = { agentId: 'cloud_agent_theirs', ownerAccountId: 'acct_priya' } as CloudAgentDefinition;
  const h = harness({ definitions: { cloud_agent_theirs: theirs } });
  const started = new Set<string>();
  for (const agentId of ['cloud-agent:acct_priya', 'cloud_agent_theirs', 'cloud_agent_unknown']) {
    assert.equal(await runDocumentAgentRequest({ ...REQUEST, agentId }, h.runtime, started), 'ignored');
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.starts.length, 0);
  assert.equal(started.size, 0);
});

test('a run the cloud or another window took is left alone', async () => {
  const h = harness({ acquired: false });
  const started = new Set<string>();
  assert.equal(await runDocumentAgentRequest(REQUEST, h.runtime, started), 'not-acquired');
  assert.deepEqual(h.actions(), ['claim']);
  assert.equal(h.starts.length, 0);
  assert.equal(await runDocumentAgentRequest(REQUEST, h.runtime, started), 'duplicate');
  assert.deepEqual(h.actions(), ['claim']);
});

test('a failed execution reports failure to the thread', async () => {
  const thrown = harness({ start: async () => { throw new Error('No provider is configured.'); } });
  assert.equal(await runDocumentAgentRequest(REQUEST, thrown.runtime, new Set()), 'failed');
  assert.deepEqual(thrown.actions(), ['claim', 'run_1/admit', 'run_1/progress']);
  assert.deepEqual(thrown.published(), [{ kind: 'agent-response', requestId: REQUEST.runRequestId, text: 'No provider is configured.', deliveryState: 'failed' }]);

  const empty = harness({ start: async () => turn({ status: 'failed', succeeded: false, assistantText: '', error: 'Model error' }) });
  assert.equal(await runDocumentAgentRequest(REQUEST, empty.runtime, new Set()), 'failed');
  assert.equal(empty.published()[0]?.deliveryState, 'failed');
  assert.equal(empty.published()[0]?.text, 'Model error');

  // A stopped turn cancels the run and posts nothing.
  const stopped = harness({ start: async () => turn({ status: 'cancelled', succeeded: false, assistantText: '' }) });
  assert.equal(await runDocumentAgentRequest(REQUEST, stopped.runtime, new Set()), 'cancelled');
  assert.deepEqual(stopped.actions(), ['claim', 'run_1/admit', 'run_1/cancel']);
});

test('a named agent runs with its own definition', async () => {
  const editor = {
    agentId: 'cloud_agent_editor', ownerAccountId: ACCOUNT, name: 'Copy Editor', role: 'editor',
    systemPrompt: 'Keep a formal tone.', boundaries: [], skills: [],
    modelRouting: { defaultModel: 'editor-model' },
  } as unknown as CloudAgentDefinition;
  const h = harness({ definitions: { cloud_agent_editor: editor } });
  const request = { ...REQUEST, agentId: 'cloud_agent_editor' };
  assert.equal(await runDocumentAgentRequest(request, h.runtime, new Set()), 'completed');
  const [, runtimeSessionId, , , route, context] = h.starts[0] as [string, string, string, string[], { model?: string }, Array<{ text: string; contextRole?: string }>];
  assert.ok(runtimeSessionId.includes(':cloud_agent_editor:request:'), runtimeSessionId);
  assert.equal(route.model, 'editor-model');
  assert.ok(context[0].text.includes('Keep a formal tone.'));
  assert.equal(context.at(-1)?.contextRole, 'runtimeIdentity');
});

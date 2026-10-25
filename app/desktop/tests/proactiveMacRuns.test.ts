import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { syncCloudDiffOnce } from '../src/features/cloud/cloudDiffSync';
import { cloudAgentRuntimeSessionId } from '../src/features/cloud/cloudAgentRuntime';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import type { ChatSyncEvent, ChatSyncSyncResponse } from '../src/features/cloud/chatSyncTypes';
import type { DesktopChatContextMessage } from '../src/lib/desktop';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import type { acquireDesktopExecutionLease } from '../src/features/cloud/cloudDesktopExecutionLease';
import {
  EVALUATION_TIMEOUT_MS,
  PROACTIVE_RUN_FOLDER_LINE,
  runProactiveApprovedOnMac,
  runProactiveEvaluationOnMac,
  type ProactiveMacRuntime,
} from '../src/features/proactive/proactiveMacRuns';
import {
  notifyProactiveRunRequests,
  parseProactiveRunRequest,
  setProactiveRunRequestHandler,
} from '../src/features/proactive/proactiveRunHints';

const owner = 'acct_owner';
const GROUP = 'session:group:g1';
const route = { model: 'openai/gpt-5.6', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: null };
const evaluation = { kind: 'evaluation', runId: 'proactive_eval_1', sessionId: GROUP } as const;
const approved = { kind: 'approved', runId: 'proactive_run_1', sessionId: GROUP, agentId: `cloud-agent:${owner}`, proposalId: 'pro_1' } as const;

const evalClaim = (proactive: Record<string, unknown> = {}) => ({
  runId: 'proactive_eval_1', acquired: true, leaseSeconds: 45,
  proactive: {
    kind: 'evaluation', systemPrompt: 'Decide whether to offer help.', prompt: 'Group snapshot', tools: [],
    model: 'gpt-5.6-luna', thinking: 'low', provider: 'openai', modelChoice: 'fast', fastModels: { openai: 'gpt-5.6-luna' },
    ...proactive,
  },
});

const approvedClaim = {
  runId: 'proactive_run_1', acquired: true, leaseSeconds: 45, contextSessionId: GROUP, trigger: 'person_started', connectorTools: [],
  turnIdentity: {
    requestId: 'msg_trigger', agentId: `cloud-agent:${owner}`, agentName: 'Kordi',
    ownerAccountId: owner, ownerName: 'Owner', requesterAccountId: owner, requesterName: 'Owner',
  },
  prompt: 'Draft the agenda the group asked for.', systemPrompt: 'The owner allowed your offer.', proactive: { kind: 'approved' },
};

const turn = (overrides: Record<string, unknown> = {}) =>
  ({ id: 'turn_1', completed: true, succeeded: true, assistantText: 'Here is the agenda.', ...overrides }) as unknown as DesktopChatTurnSnapshot;

function runtime(claim: unknown, overrides: Partial<ProactiveMacRuntime> = {}) {
  const calls: Array<{ kind: 'execution' | 'post'; path: string; body: unknown }> = [];
  const reports: string[] = [];
  const value: ProactiveMacRuntime = {
    accountId: owner, token: 'token', route,
    client: {
      desktopAgentExecution: async <T,>(_token: string, action: string, body: unknown) => {
        calls.push({ kind: 'execution', path: action, body });
        if (action === 'claim') return claim as T;
        if (action.endsWith('/admit')) return { admitted: true, cancelRequested: false } as T;
        if (action.endsWith('/release')) return { released: true } as T;
        return { ok: true } as T;
      },
    },
    post: async (path, body) => { calls.push({ kind: 'post', path, body }); return { ok: true }; },
    report: (message) => { reports.push(message); },
    runTurn: async () => '{"offer":null}',
    startTurn: async () => turn(),
    handBackRetryMs: 1,
    ...overrides,
  };
  const claimBody = () => calls.find((call) => call.path === 'claim')!.body as Record<string, unknown>;
  return { value, calls, reports, claimBody };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('only proactive hints with their own run prefix are accepted', () => {
  assert.deepEqual(parseProactiveRunRequest('proactive.eval_requested', { runId: 'proactive_eval_1', sessionId: GROUP }), evaluation);
  assert.deepEqual(parseProactiveRunRequest('proactive.run_requested', { runId: 'proactive_run_1', sessionId: GROUP, agentId: approved.agentId, proposalId: 'pro_1' }), approved);
  assert.equal(parseProactiveRunRequest('proactive.run_requested', { runId: 'proactive_eval_1', sessionId: GROUP }), null);
  assert.equal(parseProactiveRunRequest('proactive.eval_requested', { runId: 'proactive_run_1', sessionId: GROUP }), null);
  assert.equal(parseProactiveRunRequest('digest.run_requested', { runId: 'proactive_eval_1', sessionId: GROUP }), null);
  assert.equal(parseProactiveRunRequest('proactive.eval_requested', { runId: 'proactive_eval_1' }), null);
});

test('each proactive run starts once, and only for the signed-in account', () => {
  const seen: string[] = [];
  const hint = (eventType: string, runId: string) => ({ eventType, payload: { runId, sessionId: GROUP, agentId: approved.agentId, proposalId: 'pro_1' } });
  notifyProactiveRunRequests([hint('proactive.eval_requested', 'proactive_eval_early')], owner);
  notifyProactiveRunRequests([hint('proactive.eval_requested', 'proactive_eval_foreign')], 'acct_other');
  const unregister = setProactiveRunRequestHandler(owner, (request) => seen.push(`${request.kind}:${request.runId}`));
  try {
    const duplicate = hint('proactive.run_requested', 'proactive_run_twice');
    notifyProactiveRunRequests([duplicate, duplicate], owner);
    notifyProactiveRunRequests([duplicate, hint('proactive.eval_requested', 'proactive_eval_early')], owner);
    notifyProactiveRunRequests([hint('proactive.run_requested', 'proactive_run_foreign')], 'acct_other');
    notifyProactiveRunRequests([hint('proactive.proposal_changed', 'proactive_run_changed')], owner);
  } finally { unregister(); }
  assert.deepEqual(seen, ['evaluation:proactive_eval_early', 'approved:proactive_run_twice']);
});

test('the chat sync hands proactive hints to this Mac for the account it syncs', async () => {
  const events: ChatSyncEvent[] = [
    ['proactive.eval_requested', { runId: 'proactive_eval_sync', sessionId: GROUP }],
    ['proactive.run_requested', { runId: 'proactive_run_sync', sessionId: GROUP, agentId: approved.agentId, proposalId: 'pro_2' }],
  ].map(([type, payload], index) => ({
    stream_seq: index + 2, event_id: `hint-${index}`, protocol_version: 2, type: type as string, critical: false,
    conversation_id: null, entity_id: null, entity_version: null, occurred_at: '2026-10-24T00:00:00Z', payload: payload as Record<string, unknown>,
  }));
  const response = {
    protocol_version: 2, events, next_cursor: '3', last_stream_seq: 3, has_more: false, server_time: '2026-10-24T00:00:00Z',
  } satisfies ChatSyncSyncResponse;
  const sync = async (accountId: string) => {
    const client = new ChatSyncSyncClient(new ChatSyncState(async () => response, () => accountId, () => undefined, () => null));
    await syncCloudDiffOnce({
      accountId, messagesByPeer: {}, loadCursor: async () => '1', commitResponse: async () => undefined,
      fetchEvents: (cursor) => client.syncCloudEvents('token', cursor),
    });
  };
  const seen: string[] = [];
  const unregister = setProactiveRunRequestHandler(owner, (request) => seen.push(request.runId));
  try {
    await sync('acct_other');
    assert.deepEqual(seen, [], 'another account sync never runs this account\'s runs');
    await sync(owner);
    await sync(owner);
  } finally { unregister(); }
  assert.deepEqual(seen, ['proactive_eval_sync', 'proactive_run_sync']);
});

test('an evaluation claims the run, renews it, runs one turn with the memory search and completes with the reply', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let finish!: (reply: string) => void;
    let ran: Parameters<NonNullable<ProactiveMacRuntime['runTurn']>>[0] | null = null;
    const search = { name: 'search_memory', description: 'Search your owner\'s memories.', parameters: { type: 'object' } };
    const { value, calls, reports, claimBody } = runtime(evalClaim({ tools: [search, { name: 3 }] }), {
      runTurn: (input) => { ran = input; return new Promise((resolve) => { finish = resolve; }); },
    });
    const outcome = runProactiveEvaluationOnMac(evaluation, value);
    await flush();
    mock.timers.tick(10_000);
    await flush();
    finish('{"offer":null}');
    assert.equal(await outcome, 'completed');
    const claim = claimBody();
    assert.equal(claim.requestMessageId, 'proactive_eval_1');
    assert.equal(claim.sessionId, GROUP);
    assert.equal(claim.ownerAccountId, owner);
    assert.equal(claim.requesterAccountId, owner);
    assert.equal(claim.runtimeRoute, undefined, 'a Mac-local route never replaces the cloud route');
    assert.deepEqual(calls.find((call) => call.path === 'proactive_eval_1/renew')?.body, { claimId: claim.claimId });
    assert.deepEqual(ran, {
      runId: 'proactive_eval_1', claimId: claim.claimId, ownerAccountId: owner,
      systemPrompt: 'Decide whether to offer help.', prompt: 'Group snapshot', tools: [search],
      route: { ...route, model: 'openai/gpt-5.6-luna', thinking: 'low' }, fallbackModel: null,
    });
    assert.deepEqual(calls.filter((call) => call.kind === 'post'), [{
      kind: 'post', path: 'proactive/desktop/proactive_eval_1/complete', body: { claimId: claim.claimId, text: '{"offer":null}' },
    }]);
    assert.ok(!calls.some((call) => call.path.endsWith('/release')));
    assert.deepEqual(reports, []);
  } finally { mock.timers.reset(); }
});

test('an evaluation this Mac cannot finish goes back to the cloud', async () => {
  const failed = runtime(evalClaim(), { runTurn: async () => { throw new Error('provider failed'); } });
  assert.equal(await runProactiveEvaluationOnMac(evaluation, failed.value), 'released');
  assert.deepEqual(failed.calls.find((call) => call.path === 'proactive_eval_1/release')?.body, { claimId: failed.claimBody().claimId });
  assert.ok(!failed.calls.some((call) => call.kind === 'post'));
  assert.ok(failed.reports.every((message) => message.startsWith('[proactive-mac]')) && failed.reports.length === 1);
  // A claim without the evaluation is handed back as well.
  const empty = runtime({ runId: 'proactive_eval_1', acquired: true, leaseSeconds: 45 });
  assert.equal(await runProactiveEvaluationOnMac(evaluation, empty.value), 'released');
  assert.ok(empty.calls.some((call) => call.path === 'proactive_eval_1/release'));
  // A run another runtime holds, or a Mac without a model, is left alone.
  const held = runtime({ runId: 'proactive_eval_1', acquired: false });
  assert.equal(await runProactiveEvaluationOnMac(evaluation, held.value), 'not-acquired');
  assert.deepEqual(held.calls.map((call) => call.path), ['claim']);
  const noModel = runtime(evalClaim(), { route: { ...route, model: '' } });
  assert.equal(await runProactiveEvaluationOnMac(evaluation, noModel.value), 'skipped');
  assert.equal(noModel.calls.length, 0);
});

test('an approved run starts a shared turn in the group and completes with its final answer', async () => {
  let started: unknown[] = [];
  const { value, calls, reports, claimBody } = runtime(approvedClaim, {
    startTurn: async (...args) => { started = args; return turn({ completed: false, assistantText: '' }); },
    waitForTurn: async () => turn({ assistantText: '  Here is the agenda.  ' }),
  });
  assert.equal(await runProactiveApprovedOnMac(approved, value), 'completed');
  const claim = claimBody();
  assert.equal(claim.requestMessageId, 'proactive_run_1');
  assert.equal(claim.sessionId, GROUP);
  assert.equal(claim.ownerAccountId, owner);
  assert.equal(claim.requesterAccountId, owner);
  assert.equal(claim.targetCloudAgentId, approved.agentId);
  assert.ok(calls.some((call) => call.path === 'proactive_run_1/admit'));
  const [requestId, sessionId, prompt, attachments, startedRoute, context, tasks, scope, , followUpRoute, workingFolder] = started as [
    string, string, string, string[], unknown, DesktopChatContextMessage[], unknown[], string, unknown, unknown, unknown,
  ];
  assert.equal(requestId, 'proactive_run_1');
  assert.equal(sessionId, `${cloudAgentRuntimeSessionId(owner, GROUP)}:request:proactive_run_1`);
  assert.equal(prompt, 'Draft the agenda the group asked for.');
  assert.deepEqual(attachments, []);
  assert.deepEqual(startedRoute, route);
  assert.deepEqual(tasks, []);
  assert.equal(scope, GROUP);
  assert.equal(followUpRoute, null);
  assert.deepEqual(workingFolder, { kind: 'proactiveRun', runId: 'proactive_run_1' }, 'the turn works in an empty folder of its own');
  assert.equal(context.find((message) => message.contextRole === 'system')?.text, `The owner allowed your offer.\n\n${PROACTIVE_RUN_FOLDER_LINE}`);
  assert.match(PROACTIVE_RUN_FOLDER_LINE, /empty folder of its own/);
  assert.match(PROACTIVE_RUN_FOLDER_LINE, /Do not search your owner's home folder or other personal folders/);
  assert.match(PROACTIVE_RUN_FOLDER_LINE, /ask for them in your answer/);
  const identity = context.find((message) => message.contextRole === 'runtimeIdentity');
  assert.equal(identity?.executionLease?.sessionId, GROUP, 'retrieval reads the group the offer was made in');
  assert.deepEqual(calls.filter((call) => call.kind === 'post'), [{
    kind: 'post', path: 'proactive/desktop/proactive_run_1/complete', body: { claimId: claim.claimId, text: 'Here is the agenda.' },
  }]);
  assert.ok(!calls.some((call) => call.path.endsWith('/release')));
  assert.deepEqual(reports, []);
});

test('an approved run without a system prompt still gets the folder line', async () => {
  let started: unknown[] = [];
  const { value } = runtime({ ...approvedClaim, systemPrompt: '' }, {
    startTurn: async (...args) => { started = args; return turn(); },
  });
  assert.equal(await runProactiveApprovedOnMac(approved, value), 'completed');
  const context = started[5] as DesktopChatContextMessage[];
  assert.deepEqual(context.filter((message) => message.contextRole === 'system').map((message) => message.text), [PROACTIVE_RUN_FOLDER_LINE]);
  assert.deepEqual(started[10], { kind: 'proactiveRun', runId: 'proactive_run_1' });
});

test('an approved run this Mac cannot finish goes back to the cloud', async () => {
  const failed = runtime(approvedClaim, { startTurn: async () => turn({ succeeded: false, assistantText: '', error: 'provider failed' }) });
  assert.equal(await runProactiveApprovedOnMac(approved, failed.value), 'released');
  assert.deepEqual(failed.calls.find((call) => call.path === 'proactive_run_1/release')?.body, { claimId: failed.claimBody().claimId });
  assert.ok(!failed.calls.some((call) => call.kind === 'post'));
  assert.equal(failed.reports.length, 1);
  const unstarted = runtime(approvedClaim, { startTurn: async () => { throw new Error('runtime unavailable'); } });
  assert.equal(await runProactiveApprovedOnMac(approved, unstarted.value), 'released');
  assert.ok(unstarted.calls.some((call) => call.path === 'proactive_run_1/release'));
  for (const claim of [{ ...approvedClaim, prompt: '' }, { ...approvedClaim, proactive: { kind: 'evaluation' } }]) {
    const wrong = runtime(claim);
    assert.equal(await runProactiveApprovedOnMac(approved, wrong.value), 'released', 'a claim without this run is handed back');
    assert.ok(!wrong.calls.some((call) => call.path.endsWith('/admit')));
  }
  const held = runtime({ runId: 'proactive_run_1', acquired: false });
  assert.equal(await runProactiveApprovedOnMac(approved, held.value), 'not-acquired');
  assert.deepEqual(held.calls.map((call) => call.path), ['claim']);
});

test('an evaluation still running after the cloud runner\'s limit goes back to the cloud and stops renewing', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    assert.equal(EVALUATION_TIMEOUT_MS, 180_000);
    const hung = runtime(evalClaim(), { runTurn: () => new Promise<string>(() => undefined) });
    const outcome = runProactiveEvaluationOnMac(evaluation, hung.value);
    await flush();
    mock.timers.tick(EVALUATION_TIMEOUT_MS - 1);
    await flush();
    assert.ok(!hung.calls.some((call) => call.path.endsWith('/release')), 'not before the limit');
    mock.timers.tick(1);
    assert.equal(await outcome, 'released');
    assert.deepEqual(hung.calls.find((call) => call.path === 'proactive_eval_1/release')?.body, { claimId: hung.claimBody().claimId });
    assert.ok(!hung.calls.some((call) => call.kind === 'post'));
    const renewals = () => hung.calls.filter((call) => call.path.endsWith('/renew')).length;
    const before = renewals();
    assert.ok(before > 0);
    mock.timers.tick(60_000);
    await flush();
    assert.equal(renewals(), before, 'the lease is no longer renewed');
    // A finished evaluation leaves no timer behind.
    const done = runtime(evalClaim());
    assert.equal(await runProactiveEvaluationOnMac(evaluation, done.value), 'completed');
    mock.timers.tick(EVALUATION_TIMEOUT_MS * 2);
    await flush();
    assert.ok(!done.calls.some((call) => call.path.endsWith('/release') || call.path.endsWith('/renew')));
  } finally { mock.timers.reset(); }
});

test('an approved run the owner stopped before its turn cancels the turn and posts nothing', async () => {
  const cancelled: string[] = [];
  const cancelledTurn = turn({ status: 'cancelled', succeeded: false, assistantText: 'Partial' });
  const stopped = runtime(approvedClaim, {
    startTurn: async () => turn({ completed: false, assistantText: '' }),
    // The stop was noted at admission, so the turn is cancelled as soon as it starts.
    waitForTurn: async () => { assert.deepEqual(cancelled, ['turn_1']); return cancelledTurn; },
    cancelTurn: async (turnId) => { cancelled.push(turnId); },
  });
  const client = stopped.value.client;
  stopped.value.client = {
    desktopAgentExecution: async <T,>(token: string, action: string, body: unknown) => (action.endsWith('/admit')
      ? (stopped.calls.push({ kind: 'execution', path: action, body }), { admitted: true, cancelRequested: true } as T)
      : client.desktopAgentExecution<T>(token, action, body)),
  };
  assert.equal(await runProactiveApprovedOnMac(approved, stopped.value), 'stopped');
  assert.deepEqual(cancelled, ['turn_1'], 'the stop cancels the turn');
  assert.deepEqual(stopped.calls.find((call) => call.path === 'proactive_run_1/cancel')?.body, { claimId: stopped.claimBody().claimId });
  assert.ok(!stopped.calls.some((call) => call.kind === 'post'), 'nothing is posted');
  assert.ok(!stopped.calls.some((call) => call.path.endsWith('/release')), 'a stopped run never goes to the cloud');
});

test('a stop that arrives while the turn runs wins over its answer', async () => {
  let stop: (() => void) | null = null;
  const leaseCalls: string[] = [];
  const lease = {
    runId: 'proactive_run_1', claimId: 'claim_1', claim: approvedClaim, project: null, deadline: Date.now() + 40_000, lost: false,
    contextMessages: (messages: readonly DesktopChatContextMessage[]) => [...messages],
    attach: (turnId: string) => { leaseCalls.push(`attach:${turnId}`); },
    admitted: async () => true,
    onStopRequested: (handler: () => void) => { stop = handler; },
    cancel: async () => { leaseCalls.push('cancel'); },
    dispose: () => { leaseCalls.push('dispose'); },
    publisher: { sendMessage: async () => { throw new Error('unused'); } },
  };
  const cancelled: string[] = [];
  let finish!: (snapshot: DesktopChatTurnSnapshot) => void;
  const run = runtime(approvedClaim, {
    acquireLease: (async () => lease) as unknown as typeof acquireDesktopExecutionLease,
    startTurn: async () => turn({ completed: false, assistantText: '' }),
    waitForTurn: () => new Promise((resolve) => { finish = resolve; }),
    cancelTurn: async (turnId) => { cancelled.push(turnId); },
  });
  const outcome = runProactiveApprovedOnMac(approved, run.value);
  await flush();
  assert.ok(stop, 'the run listens for a stop');
  stop!();
  // The turn had already finished its answer when the cancel arrived.
  finish(turn({ assistantText: 'Here is the agenda.' }));
  assert.equal(await outcome, 'stopped');
  assert.deepEqual(cancelled, ['turn_1']);
  assert.deepEqual(leaseCalls, ['attach:turn_1', 'cancel', 'dispose']);
  assert.ok(!run.calls.some((call) => call.kind === 'post'), 'the answer is not posted');
});

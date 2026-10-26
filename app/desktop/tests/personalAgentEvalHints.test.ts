import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncCloudDiffOnce } from '../src/features/cloud/cloudDiffSync';
import { ACCOUNT_HINT_EVENT_TYPES } from '../src/features/cloud/accountHintEvents';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import type { ChatSyncEvent, ChatSyncSyncResponse } from '../src/features/cloud/chatSyncTypes';
import { runProactiveOnMac, type ProactiveMacRuntime } from '../src/features/proactive/proactiveMacRuns';
import {
  PERSONAL_AGENT_EVAL_REQUESTED_EVENT,
  notifyProactiveRunRequests,
  parseProactiveRunRequest,
  setProactiveRunRequestHandler,
} from '../src/features/proactive/proactiveRunHints';

const owner = 'acct_owner';
const SESSION = `personal-agent:cloud-agent:${owner}`;
const route = { model: 'openai/gpt-5.6', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: null };

test('a personal agent evaluation hint is read as an evaluation only with its own run prefix', () => {
  assert.equal(PERSONAL_AGENT_EVAL_REQUESTED_EVENT, 'personal_agent.eval_requested');
  assert.ok(ACCOUNT_HINT_EVENT_TYPES.has('personal_agent.eval_requested'));
  assert.deepEqual(
    parseProactiveRunRequest('personal_agent.eval_requested', { runId: 'personal_agent_eval_1', sessionId: SESSION }),
    { kind: 'evaluation', runId: 'personal_agent_eval_1', sessionId: SESSION },
  );
  assert.equal(parseProactiveRunRequest('personal_agent.eval_requested', { runId: 'proactive_eval_1', sessionId: SESSION }), null);
  assert.equal(parseProactiveRunRequest('personal_agent.eval_requested', { runId: 'proactive_run_1', sessionId: SESSION }), null);
  assert.equal(parseProactiveRunRequest('proactive.eval_requested', { runId: 'personal_agent_eval_1', sessionId: SESSION }), null);
  assert.equal(parseProactiveRunRequest('proactive.run_requested', { runId: 'personal_agent_eval_1', sessionId: SESSION }), null);
  assert.equal(parseProactiveRunRequest('personal_agent.eval_requested', { runId: 'personal_agent_eval_1' }), null);
});

test('a personal agent evaluation hint reaches this Mac once, for the signed-in account', () => {
  const seen: string[] = [];
  const hint = (runId: string) => ({ eventType: 'personal_agent.eval_requested', payload: { runId, sessionId: SESSION } });
  notifyProactiveRunRequests([hint('personal_agent_eval_early')], owner);
  const unregister = setProactiveRunRequestHandler(owner, (request) => seen.push(`${request.kind}:${request.runId}`));
  try {
    notifyProactiveRunRequests([hint('personal_agent_eval_twice'), hint('personal_agent_eval_twice')], owner);
    notifyProactiveRunRequests([hint('personal_agent_eval_foreign')], 'acct_other');
  } finally { unregister(); }
  assert.deepEqual(seen, ['evaluation:personal_agent_eval_early', 'evaluation:personal_agent_eval_twice']);
});

test('the chat sync hands personal agent evaluation hints to this Mac', async () => {
  const event: ChatSyncEvent = {
    stream_seq: 2, event_id: 'hint-personal', protocol_version: 2, type: 'personal_agent.eval_requested', critical: false,
    conversation_id: null, entity_id: null, entity_version: null, occurred_at: '2026-10-25T00:00:00Z',
    payload: { runId: 'personal_agent_eval_sync', sessionId: SESSION },
  };
  const response = {
    protocol_version: 2, events: [event], next_cursor: '2', last_stream_seq: 2, has_more: false, server_time: '2026-10-25T00:00:00Z',
  } satisfies ChatSyncSyncResponse;
  const client = new ChatSyncSyncClient(new ChatSyncState(async () => response, () => owner, () => undefined, () => null));
  const seen: string[] = [];
  const unregister = setProactiveRunRequestHandler(owner, (request) => seen.push(request.runId));
  try {
    await syncCloudDiffOnce({
      accountId: owner, messagesByPeer: {}, loadCursor: async () => '1', commitResponse: async () => undefined,
      fetchEvents: (cursor) => client.syncCloudEvents('token', cursor),
    });
  } finally { unregister(); }
  assert.deepEqual(seen, ['personal_agent_eval_sync']);
});

test('a personal agent evaluation runs like a proactive evaluation and completes through the proactive route', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  let ran: Parameters<NonNullable<ProactiveMacRuntime['runTurn']>>[0] | null = null;
  const runtime: ProactiveMacRuntime = {
    accountId: owner, token: 'token', route,
    client: {
      desktopAgentExecution: async <T,>(_token: string, action: string, body: unknown) => {
        calls.push({ path: action, body });
        if (action === 'claim') {
          return {
            runId: 'personal_agent_eval_1', acquired: true,
            proactive: { kind: 'evaluation', systemPrompt: 'Decide whether to tell your owner.', prompt: '{"events":[]}', tools: [] },
          } as T;
        }
        return { ok: true } as T;
      },
    },
    post: async (path, body) => { calls.push({ path, body }); return { ok: true }; },
    runTurn: async (input) => { ran = input; return '{"decision":"skip"}'; },
    handBackRetryMs: 1,
  };
  const outcome = await runProactiveOnMac({ kind: 'evaluation', runId: 'personal_agent_eval_1', sessionId: SESSION }, runtime);
  assert.equal(outcome, 'completed');
  const claim = calls.find((call) => call.path === 'claim')!.body as Record<string, unknown>;
  assert.equal(claim.requestMessageId, 'personal_agent_eval_1');
  assert.equal(claim.idempotencyKey, 'personal_agent_eval_1');
  assert.equal(claim.sessionId, SESSION);
  assert.equal(ran!.prompt, '{"events":[]}');
  assert.deepEqual(calls.at(-1), {
    path: 'proactive/desktop/personal_agent_eval_1/complete',
    body: { claimId: claim.claimId, text: '{"decision":"skip"}' },
  });
});

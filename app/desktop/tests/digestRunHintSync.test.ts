import assert from 'node:assert/strict';
import { test } from 'node:test';

import { syncCloudDiffOnce } from '../src/features/cloud/cloudDiffSync';
import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import type { ChatSyncEvent, ChatSyncSyncResponse } from '../src/features/cloud/chatSyncTypes';
import { runDigestOnMac, setDigestRunRequestHandler } from '../src/features/digest/digestMacRuns';

const owner = 'acct_owner';
const route = { model: 'openai/gpt-5.6', authProvider: 'openai', authChoice: 'local-active-oauth', thinking: null };
/** The server holds a new digest run for a ready Mac for one presence timeout. */
const HOLD_MS = 35_000;

function hint(type: string, payload: Record<string, unknown>, seq: number): ChatSyncEvent {
  return {
    stream_seq: seq, event_id: `hint-${seq}`, protocol_version: 2, type, critical: false,
    conversation_id: null, entity_id: null, entity_version: null, occurred_at: '2026-10-19T00:00:00Z', payload,
  };
}

function syncClient(events: ChatSyncEvent[]) {
  const last = events.at(-1)?.stream_seq ?? 1;
  const response = {
    protocol_version: 2, events, next_cursor: String(last), last_stream_seq: last,
    has_more: false, server_time: '2026-10-19T00:00:00Z',
  } satisfies ChatSyncSyncResponse;
  const state = new ChatSyncState(async () => response, () => owner, () => undefined, () => null);
  return new ChatSyncSyncClient(state);
}

test('the reliable chat sync hands account hints to the Mac handlers', async () => {
  const digest = hint('digest.run_requested', { runId: 'digest_1', sessionId: `digest:${owner}` }, 2);
  const comment = hint('document.agent_request', { requestId: 'comment_1' }, 3);
  const result = await syncClient([digest, comment]).syncCloudEvents('token', '1');
  assert.deepEqual(
    result.events.map((event) => [event.eventType, event.payload]),
    [['digest.run_requested', digest.payload], ['document.agent_request', comment.payload]],
  );
});

test('a ready Mac claims a held digest run from one sync pass, within the hold', async () => {
  const heldUntil = Date.now() + HOLD_MS;
  const claims: Array<{ at: number; body: Record<string, unknown> }> = [];
  const outcomes: Promise<string>[] = [];
  setDigestRunRequestHandler((request) => {
    outcomes.push(runDigestOnMac(request, {
      accountId: owner, token: 'token', route,
      client: {
        desktopAgentExecution: async <T,>(_token: string, action: string, body: unknown) => {
          if (action === 'claim') claims.push({ at: Date.now(), body: body as Record<string, unknown> });
          return (action === 'claim'
            ? { runId: 'digest_1', acquired: true, digest: { systemPrompt: 's', prompt: 'p', tools: [] } }
            : { ok: true }) as T;
        },
      },
      post: async () => ({ ok: true }),
      run: async () => '{"claims":[]}',
    }));
  });
  try {
    const client = syncClient([hint('digest.run_requested', { runId: 'digest_1', sessionId: `digest:${owner}` }, 2)]);
    await syncCloudDiffOnce({
      accountId: owner,
      messagesByPeer: {},
      loadCursor: async () => '1',
      commitResponse: async () => undefined,
      fetchEvents: (cursor) => client.syncCloudEvents('token', cursor),
    });
    assert.deepEqual(await Promise.all(outcomes), ['completed']);
  } finally {
    setDigestRunRequestHandler(null);
  }
  assert.equal(claims.length, 1, 'the Mac claims the announced run');
  assert.equal(claims[0]!.body.requestMessageId, 'digest_1');
  assert.equal(claims[0]!.body.sessionId, `digest:${owner}`);
  assert.ok(claims[0]!.at < heldUntil, 'the claim lands before the cloud may take the run');
});

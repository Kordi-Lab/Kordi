import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from '../src/runtime';
import type { RunRequest } from '../src/protocol';

test('ChatGPT OAuth uses Codex transport with the selected account and streams a reply', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'kordi-codex-test-'));
  const token = `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.unsigned`;
  const received: any[] = [];
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Codex reply.', annotations: [] }] };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST') return new Response('HTTP only', { status: 426 });
    received.push({ path: new URL(request.url).pathname, account: request.headers.get('chatgpt-account-id'), authorization: request.headers.get('authorization'), body: await request.json() });
    const events = [
      { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Codex reply.' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const request: RunRequest = {
      schemaVersion: 1, type: 'run', requestId: 'r', runId: 'r', attemptId: 'a', sessionId: 's', cwd,
      model: { provider: 'openai-codex', id: 'gpt-5.5', api: 'openai-codex-responses', baseUrl: `http://127.0.0.1:${server.port}/backend-api` },
      auth: { kind: 'oauth', credential: token, headers: { 'chatgpt-account-id': 'synthetic-account' } },
      systemPrompt: 'Synthetic transport test.', messages: [], prompt: { text: 'Hello.' }, tools: [],
      limits: { timeoutMs: 15000, maxOutputBytes: 1048576, maxToolCalls: 2, maxSteps: 2 },
    };
    const events: any[] = [];
    const result = await runTurn(request, { event: event => events.push(event), tool: async () => { throw Error('unexpected tool'); } }, new AbortController().signal);
    expect(result.text).toBe('Codex reply.');
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/backend-api/codex/responses');
    expect(received[0].account).toBe('synthetic-account');
    expect(received[0].authorization).toBe(`Bearer ${token}`);
    expect(received[0].body.model).toBe('gpt-5.5');
    expect(events.some(event => event.kind === 'text_delta')).toBe(true);
  } finally { server.stop(true); await rm(cwd, { recursive: true, force: true }); }
}, 20000);

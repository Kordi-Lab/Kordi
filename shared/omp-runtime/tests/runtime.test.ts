import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from '../src/runtime';
import { parseCommand, type RunRequest } from '../src/protocol';
import { toKordiMessage, toOmpMessage } from '../src/messages';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(respond: (body: any, request: Request) => any[]) {
  const cwd = await mkdtemp(join(tmpdir(), 'kordi-omp-test-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const requests: any[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json(); requests.push(body);
    const chunks = respond(body, request);
    return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }});
  cleanup.push(() => server.stop(true));
  const request: RunRequest = {
    schemaVersion: 1, type: 'run', requestId: 'request-1', runId: 'run-1', attemptId: 'attempt-1', sessionId: 'session-1', cwd,
    model: { provider: 'fixture-provider', id: 'fixture-model', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1` },
    auth: { kind: 'api_key', credential: 'synthetic-test-key' }, systemPrompt: 'You are a test agent.', messages: [],
    prompt: { text: 'Say hello.' }, tools: [], limits: { timeoutMs: 15000, maxOutputBytes: 1048576, maxToolCalls: 4, maxSteps: 4 },
  };
  return { request, requests };
}
const textChunks = (text: string) => [
  { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
];

test('real OMP loop uses the exact route and emits progress before final text', async () => {
  const { request, requests } = await fixture((_, req) => {
    expect(req.headers.get('authorization')).toBe('Bearer synthetic-test-key');
    return textChunks('Hello.');
  });
  const events: any[] = [];
  const result = await runTurn(request, { event: event => events.push(event), tool: async () => { throw Error('unexpected tool'); } }, new AbortController().signal);
  expect(result.text).toBe('Hello.');
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0].stop_reason).toBe('stop');
  expect(events[0]).toEqual({ kind: 'status', status: 'starting' });
  expect(events.some(e => e.status === 'running')).toBe(true);
  expect(events.some(e => e.kind === 'text_delta')).toBe(true);
  expect(requests[0].model).toBe('fixture-model');
  expect(requests[0].tools ?? []).toHaveLength(0);
  expect(events.filter(event => event.kind === 'message_end').map(event => event.message.role)).toEqual(['user', 'assistant']);
}, 20000);

test.each(['fixture_tool', 'read', 'bash', 'edit'])('host tool %s preserves invocation ID and overrides builtins', async (toolName) => {
  const { request, requests } = await fixture(body => body.messages.some((m: any) => m.role === 'tool') ? textChunks('Tool complete.') : [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-42', type: 'function', function: { name: toolName, arguments: '{"value":"hello"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  request.tools = [{ name: toolName, description: 'Test host tool', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }];
  const calls: any[] = [];
  const result = await runTurn(request, { event: () => {}, tool: async (id, name, input) => {
    calls.push({ id, name, input }); return { ok: true, content: [{ type: 'text', text: 'Tool output' }], details: { tool_call_id: 'must-not-rename' } };
  }}, new AbortController().signal);
  expect(calls).toEqual([{ id: 'call-42', name: toolName, input: { value: 'hello' } }]);
  expect(result.text).toBe('Tool complete.');
  expect(result.messages.filter(m => m.role === 'toolResult')).toHaveLength(1);
  expect(result.messages.find(m => m.role === 'toolResult')?.tool_call_id).toBe('call-42');
  expect(requests).toHaveLength(2);
}, 20000);

test('message conversion preserves tool payload keys and images', () => {
  const message = { role: 'toolResult', tool_call_id: 'id', tool_name: 'tool', is_error: false, timestamp: 1,
    content: [{ type: 'image', mime_type: 'image/png', data: 'test' }], details: { cache_read: 9 } };
  expect(toKordiMessage(toOmpMessage(message, 'openai-completions'))).toEqual(message);
});
test('restricted runs reject computer/browser capability escalation', () => {
  expect(() => parseCommand(JSON.stringify({ schemaVersion: 1, type: 'run', runId: 'r', attemptId: 'a', capabilities: { ownerLocal: false, computer: true, browser: false } }))).toThrow();
});

test('continuation retains the earlier answer exactly once', async () => {
  const { request, requests } = await fixture(() => textChunks('Second answer.'));
  request.messages = [
    { role: 'user', content: [{ type: 'text', text: 'Earlier question.' }], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer.' }], provider: 'fixture-provider', model: 'fixture-model',
      usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } }, stop_reason: 'stop', timestamp: 2 },
  ];
  const result = await runTurn(request, { event: () => {}, tool: async () => { throw Error('unexpected'); } }, new AbortController().signal);
  expect(JSON.stringify(requests[0].messages).match(/Earlier answer\./g)).toHaveLength(1);
  expect(result.messages).toHaveLength(1);
  expect(result.text).toBe('Second answer.');
}, 20000);

test('cancellation interrupts a host tool and cannot produce a completed reply', async () => {
  const { request } = await fixture(() => [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'waiting-call', type: 'function', function: { name: 'wait_tool', arguments: '{}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  request.tools = [{ name: 'wait_tool', description: 'Wait', inputSchema: { type: 'object', properties: {} } }];
  const controller = new AbortController();
  const events: any[] = [];
  await expect(runTurn(request, { event: e => events.push(e), tool: async (_id, _name, _input, signal) => {
    queueMicrotask(() => controller.abort());
    await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
    return { ok: false, content: [{ type: 'text', text: 'Cancelled' }] };
  } }, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  expect(events.some(e => e.status === 'completed')).toBe(false);
}, 20000);

test('bounded model steps stop a repeating tool loop', async () => {
  let call = 0;
  const { request, requests } = await fixture(() => [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${++call}`, type: 'function', function: { name: 'repeat', arguments: '{}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  request.tools = [{ name: 'repeat', description: 'Repeat', inputSchema: { type: 'object', properties: {} } }];
  request.limits.maxSteps = 2;
  await expect(runTurn(request, { event: () => {}, tool: async () => ({ ok: true, content: [{ type: 'text', text: 'again' }] }) }, new AbortController().signal)).rejects.toMatchObject({ code: 'step_limit' });
  expect(requests).toHaveLength(2);
}, 20000);

test('JSONL worker emits ordered lifecycle and a single terminal result', async () => {
  const { request } = await fixture(() => textChunks('Worker reply.'));
  const worker = Bun.spawn([process.execPath, 'run', 'src/worker.ts'], { cwd: join(import.meta.dir, '..'), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  cleanup.push(() => { worker.kill(); });
  const lines: any[] = [];
  const reader = worker.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); lines.push(line);
      if (line.type === 'ready' && !started) { started = true; worker.stdin.write(`${JSON.stringify(request)}\n`); }
    }
  }
  expect(await worker.exited).toBe(0);
  expect(lines.filter(line => ['result', 'error'].includes(line.type))).toHaveLength(1);
  expect(lines.at(-1)?.text).toBe('Worker reply.');
  expect(lines.slice(1).map(line => line.sequence)).toEqual(lines.slice(1).map((_, index) => index + 1));
}, 20000);

test('compaction returns a boundary that maps back to Kordi history', async () => {
  const { request, requests } = await fixture(() => textChunks('Preserved conversation summary.'));
  request.model.contextWindow = 16000;
  request.model.maxTokens = 1000;
  request.compaction = { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000, thresholdTokens: 2000 };
  request.messages = Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? {
    role: 'user', content: [{ type: 'text', text: `History ${index}. ${'Earlier conversation details. '.repeat(100)}` }], timestamp: index + 1,
  } : {
    role: 'assistant', content: [{ type: 'text', text: `Answer ${index}. ${'Earlier answer details. '.repeat(100)}` }], timestamp: index + 1,
    provider: request.model.provider, model: request.model.id, stop_reason: 'stop',
    usage: { input: 3000, output: 1000, cache_read: 0, cache_write: 0, total_tokens: 4000, cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 } },
  });
  request.messageEntryIds = request.messages.map((_, index) => `entry-${index}`);
  request.prompt.entryId = 'current-prompt';
  const events: any[] = [];
  const result = await runTurn(request, { event: e => events.push(e), tool: async () => { throw Error('unexpected'); } }, new AbortController().signal);
  expect(events.some(e => e.kind === 'compaction')).toBe(true);
  expect(result.checkpoint).toBeDefined();
  expect(result.checkpoint!.firstKeptMessageIndex).toBeGreaterThanOrEqual(0);
  expect(result.checkpoint!.firstKeptEntryId).toBe(request.messageEntryIds[result.checkpoint!.firstKeptMessageIndex] ?? 'current-prompt');
  expect(requests.length).toBeGreaterThanOrEqual(2);
}, 20000);

test('restricted host hooks transform every model step without adding ambient tools', async () => {
  const { request, requests } = await fixture(body => body.messages.some((m: any) => m.role === 'tool') ? textChunks('Hooked reply.') : [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'hook-tool', type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  request.tools = [{ name: 'read', description: 'Host read', inputSchema: { type: 'object', properties: {} } }];
  request.hooks = ['context', 'before_provider_request'];
  let contexts = 0;
  let payloads = 0;
  const result = await runTurn(request, {
    event: () => {},
    tool: async () => ({ ok: true, content: [{ type: 'text', text: 'Read result' }] }),
    hook: async (name, input) => {
      if (name === 'context') return { messages: [...input.messages, { role: 'user', content: [{ type: 'text', text: `Hook context ${++contexts}` }], timestamp: 1 }] };
      payloads++;
      return { payload: { ...input.payload, temperature: 0.3 } };
    },
  }, new AbortController().signal);
  expect(result.text).toBe('Hooked reply.');
  expect(contexts).toBe(2);
  expect(payloads).toBe(2);
  expect(requests.every(body => body.temperature === 0.3)).toBe(true);
  expect(JSON.stringify(requests[1].messages)).toContain('Hook context 2');
  expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(['read']);
  expect(JSON.stringify(result.messages)).not.toContain('Hook context');
}, 20000);

test('a plugin cannot redirect the selected model', async () => {
  const { request, requests } = await fixture(() => textChunks('Must not run.'));
  request.hooks = ['before_provider_request'];
  await expect(runTurn(request, {
    event: () => {}, tool: async () => { throw Error('unexpected'); },
    hook: async (_name, input) => ({ payload: { ...input.payload, model: 'other-model' } }),
  }, new AbortController().signal)).rejects.toMatchObject({ code: 'hook_error' });
  expect(requests).toHaveLength(0);
}, 20000);

test('BeforeAgentStart custom context stays after the current prompt on every step', async () => {
  const { request, requests } = await fixture(body => body.messages.some((m: any) => m.role === 'tool') ? textChunks('Done.') : [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'custom-tool', type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  request.prompt.trailingMessages = [{ role: 'custom', custom_type: 'plugin-context', content: [{ type: 'text', text: 'Current plugin context' }], display: false, timestamp: 1 }];
  request.tools = [{ name: 'read', description: 'Host read', inputSchema: { type: 'object', properties: {} } }];
  const result = await runTurn(request, {
    event: () => {}, tool: async () => ({ ok: true, content: [{ type: 'text', text: 'result' }] }),
  }, new AbortController().signal);
  expect(requests).toHaveLength(2);
  for (const body of requests) {
    const wire = JSON.stringify(body.messages);
    expect(wire.indexOf('Say hello.')).toBeLessThan(wire.indexOf('Current plugin context'));
    expect(wire.match(/Current plugin context/g)).toHaveLength(1);
  }
  expect(JSON.stringify(result.messages)).not.toContain('Current plugin context');
}, 20000);


test('explicit provider continuation preserves completed tools without adding a user request', async () => {
  const { request, requests } = await fixture(body => {
    expect(body.messages.filter((message: any) => message.role === 'user')).toHaveLength(1);
    expect(body.messages.some((message: any) => message.role === 'tool' && message.content.includes('already applied'))).toBe(true);
    return textChunks('Continuation complete.');
  });
  request.messages = [
    {role:'user',content:[{type:'text',text:'Apply once.'}],timestamp:1},
    {role:'assistant',content:[{type:'toolCall',id:'applied',name:'fixture_tool',arguments:{}}],stop_reason:'toolUse',timestamp:2},
    {role:'toolResult',tool_call_id:'applied',tool_name:'fixture_tool',content:[{type:'text',text:'already applied'}],is_error:false,timestamp:3},
  ];
  request.prompt = {text:'',resume:true};
  request.tools = [{name:'fixture_tool',description:'Apply once',inputSchema:{type:'object'}}];
  const result = await runTurn(request, {event:()=>{},tool:async()=>{throw Error('completed action replayed');}}, new AbortController().signal);
  expect(result.text).toBe('Continuation complete.');
  expect(requests).toHaveLength(1);
  expect(result.contextMessages.filter(message=>message.role==='user')).toHaveLength(1);
}, 20000);

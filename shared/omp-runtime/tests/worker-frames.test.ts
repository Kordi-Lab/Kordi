import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const workerEntry = join(import.meta.dir, '../src/worker.ts');

/** Drives the real JSONL worker against a local provider for `steps` tool rounds. */
async function runWorker(options: { steps: number; deltasPerStep: number; toolBytes: number; maxOutputBytes: number }) {
  const cwd = await mkdtemp(join(tmpdir(), 'kordi-omp-frames-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  let step = 0;
  const chunk = (body: object) => `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', ...body })}\n\n`;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    await request.json();
    step += 1;
    let body = '';
    for (let index = 0; index < options.deltasPerStep; index++) {
      body += chunk({ choices: [{ index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), content: `s${step}w${index} ` }, finish_reason: null }] });
    }
    body += step <= options.steps
      ? chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: null }] })
        + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      : chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
    return new Response(`${body}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }});
  cleanup.push(() => server.stop(true));
  const worker = Bun.spawn(['bun', 'run', workerEntry], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  cleanup.push(() => worker.kill());
  const send = (value: object) => worker.stdin.write(`${JSON.stringify({ schemaVersion: 1, ...value })}\n`);
  send({ type: 'run', requestId: 'request-1', runId: 'run-1', attemptId: 'attempt-1', sessionId: 'session-1', cwd,
    model: { provider: 'fixture-provider', id: 'fixture-model', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1` },
    auth: { kind: 'api_key', credential: 'synthetic-test-key' }, systemPrompt: 'You are a test agent.', messages: [],
    prompt: { text: 'Collect notes.' },
    tools: [{ name: 'lookup', description: 'Look up notes', inputSchema: { type: 'object', properties: {} } }],
    limits: { timeoutMs: 60000, maxOutputBytes: options.maxOutputBytes } });
  const frames: any[] = [];
  let streamBytes = 0;
  let buffered = '';
  const decoder = new TextDecoder();
  for await (const part of worker.stdout) {
    buffered += decoder.decode(part, { stream: true });
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      streamBytes += Buffer.byteLength(line) + 1;
      expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(options.maxOutputBytes);
      const frame = JSON.parse(line);
      frames.push(frame);
      if (frame.type === 'tool_call') {
        send({ type: 'tool_result', runId: 'run-1', attemptId: 'attempt-1', callId: frame.callId,
          result: { ok: true, content: [{ type: 'text', text: 'n'.repeat(options.toolBytes) }] } });
      }
      if (frame.type === 'result' || frame.type === 'error') worker.stdin.end();
    }
  }
  const sequences = frames.filter(frame => frame.sequence !== undefined).map(frame => frame.sequence);
  // The host rejects any gap as an invalid response.
  expect(sequences).toEqual(sequences.map((_, index) => index + 1));
  return { terminal: frames.at(-1), streamBytes };
}

test('a long run whose stream exceeds the frame limit still returns its result', async () => {
  const { terminal, streamBytes } = await runWorker({ steps: 6, deltasPerStep: 300, toolBytes: 2000, maxOutputBytes: 150_000 });
  expect(streamBytes).toBeGreaterThan(150_000);
  expect(terminal.type).toBe('result');
  expect(terminal.text).toContain('s7w299');
}, 60000);

test('an oversized result becomes an output-limit error with the next sequence number', async () => {
  const { terminal } = await runWorker({ steps: 3, deltasPerStep: 1, toolBytes: 30_000, maxOutputBytes: 100_000 });
  expect(terminal).toMatchObject({ type: 'error', code: 'output_limit' });
}, 60000);

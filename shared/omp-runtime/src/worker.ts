import { createInterface } from 'node:readline';
import { parentPort } from 'node:worker_threads';
import { declareWorkerHostEntry, installWorkerInbox } from '@oh-my-pi/pi-utils/worker-host';
import { parseCommand, RuntimeError, type JsonObject, type RunRequest, type ToolResult } from './protocol';
import runtimePackage from '../package.json';

if (process.argv.includes('--version')) {
  process.stdout.write(`kordi-omp ${runtimePackage.dependencies['@oh-my-pi/pi-coding-agent']}\n`);
  process.exit(0);
}

if (Bun.isMainThread) declareWorkerHostEntry();
const selectedWorker = process.argv.find(argument => [
  '__omp_worker_computer', '__omp_worker_tab', '__omp_worker_js_eval',
].includes(argument));
if (selectedWorker) {
  if (parentPort) installWorkerInbox(parentPort);
  if (selectedWorker === '__omp_worker_computer') {
    const { startComputerWorker } = await import('@oh-my-pi/pi-coding-agent/tools/computer/worker-entry');
    startComputerWorker();
  } else if (selectedWorker === '__omp_worker_tab') {
    await import('@oh-my-pi/pi-coding-agent/tools/browser/tab-worker-entry');
  } else {
    await import('@oh-my-pi/pi-coding-agent/eval/js/worker-entry');
  }
}
if (!selectedWorker && process.argv.includes('__omp_worker_daemon_broker')) {
  const { startDaemonBrokerFromEnvironment } = await import('@oh-my-pi/pi-coding-agent/launch/broker');
  await startDaemonBrokerFromEnvironment();
  process.exit(0);
}
if (!selectedWorker && process.argv.includes('browser-relay')) {
  const { runBrowserRelayCommand, DEFAULT_RELAY_PORT } = await import('@oh-my-pi/pi-coding-agent/cli/browser-relay-cli');
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : DEFAULT_RELAY_PORT;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid OMP browser relay port.');
  await runBrowserRelayCommand({ action: 'serve', port });
  process.exit(0);
}
// OMP's Eval kernel re-enters the compiled executable with this private selector.
// Dispatch before the JSONL protocol starts so its IPC handshake reaches the
// isolated worker instead of becoming a second Kordi run.
if (!selectedWorker && process.argv.includes('__omp_worker_js_eval_process')) {
  const [{ startJsEvalProcess }, { interceptUnhandledRejections }] = await Promise.all([
    import('@oh-my-pi/pi-coding-agent/eval/js/process-entry'),
    import('@oh-my-pi/pi-utils/postmortem.js'),
  ]);
  const { promise, resolve } = Promise.withResolvers<void>();
  process.on('disconnect', resolve);
  startJsEvalProcess({
    send: message => { process.send?.(message); },
    onMessage: handler => {
      const listener = (message: unknown) => handler(message as Parameters<typeof handler>[0]);
      process.on('message', listener);
      return () => process.off('message', listener);
    },
  }, interceptUnhandledRejections);
  await promise;
  process.exit(0);
}
if (!selectedWorker && process.argv.includes('__kordi_smoke_eval')) {
  const { executeInVmContext, resetVmContext } = await import('@oh-my-pi/pi-coding-agent/eval/js/context-manager');
  let output = '';
  await executeInVmContext({
    sessionKey: 'packaged-smoke', sessionId: 'packaged-smoke', cwd: process.cwd(),
    session: { cwd: process.cwd(), getEvalPreludes: () => [] } as never,
    code: 'console.log(1 + 1)', filename: 'packaged-smoke.ts',
    runState: { onText: chunk => { output += chunk; } }, timeoutMs: 10_000,
  });
  await resetVmContext('packaged-smoke');
  if (output.trim() !== '2') throw new Error('Packaged Eval did not execute 1 + 1.');
  const { spawnComputerWorker } = await import('@oh-my-pi/pi-coding-agent/tools/computer/supervisor');
  const computerWorker = spawnComputerWorker();
  try {
    const capabilities = await Promise.race([
      new Promise<Record<string, unknown>>((resolve, reject) => {
        computerWorker.onError(reject);
        computerWorker.onMessage(message => {
          if (message.type === 'ready') {
            computerWorker.send({ type: 'capabilities', id: 'packaged-smoke',
              session: { cwd: process.cwd(), sessionId: 'packaged-smoke', captureMaxWidth: 1280,
                captureMaxHeight: 896, display: 'primary', readOnly: true } });
          } else if (message.type === 'capabilities') {
            if (message.ok) resolve(message.capabilities as unknown as Record<string, unknown>);
            else reject(new Error(message.error.message));
          }
        });
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Packaged computer worker timed out.')), 10_000)),
    ]);
    if (typeof capabilities.capture !== 'boolean' || typeof capabilities.input !== 'boolean'
      || typeof capabilities.ax !== 'boolean') throw new Error('Packaged computer capabilities were malformed.');
  } finally {
    computerWorker.send({ type: 'close' });
    await computerWorker.terminate();
  }
  const [{ Settings }, { createComputerPrelude }] = await Promise.all([
    import('@oh-my-pi/pi-coding-agent'), import('@oh-my-pi/pi-coding-agent/tools/computer'),
  ]);
  const settings = Settings.isolated({ 'computer.enabled': true, 'browser.enabled': false });
  let prelude: ReturnType<typeof createComputerPrelude>;
  const computerSession = {
    cwd: process.cwd(), settings, getEvalSessionId: () => 'packaged-computer-smoke',
    getEvalPreludes: () => [prelude],
  } as never;
  prelude = createComputerPrelude(computerSession);
  let computerOutput = '';
  try {
    await executeInVmContext({
      sessionKey: 'packaged-computer-smoke', sessionId: 'packaged-computer-smoke', cwd: process.cwd(),
      session: computerSession, code: 'const c = await computer.capabilities(); console.log(`capability-probe:${typeof c?.backend}`)',
      filename: 'packaged-computer-smoke.ts',
      runState: { onText: chunk => { computerOutput += chunk; } }, timeoutMs: 10_000,
    });
  } finally {
    await resetVmContext('packaged-computer-smoke');
    await prelude.invoke({ action: 'close' }, { session: computerSession, toolCallId: 'packaged-smoke' });
  }
  if (!computerOutput.includes('capability-probe:string')) throw new Error('Packaged computer Eval prelude did not execute.');
  const browserWorker = new Worker(Bun.main, { type: 'module', argv: ['__omp_worker_tab'] });
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        browserWorker.addEventListener('message', event => {
          if (event.data?.type === 'closed') resolve();
        });
        browserWorker.addEventListener('error', event => reject(event.error ?? new Error(event.message)));
        browserWorker.postMessage({ type: 'close' });
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Packaged browser worker timed out.')), 10_000)),
    ]);
  } finally {
    browserWorker.terminate();
  }
  if (process.env.KORDI_OMP_SMOKE_BLANK_BROWSER === '1') {
    const [{ mkdtemp, rm }, { tmpdir }, { join }, { createBrowserPrelude },
      { closeDaemonClients, daemonClientForProject }, { sharedBrowserDaemonName }] = await Promise.all([
      import('node:fs/promises'), import('node:os'), import('node:path'),
      import('@oh-my-pi/pi-coding-agent/tools/browser'), import('@oh-my-pi/pi-coding-agent/launch/client'),
      import('@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon'),
    ]);
    const browserCwd = await mkdtemp(join(tmpdir(), 'kordi-omp-browser-smoke-'));
    const browserSettings = Settings.isolated({ 'browser.enabled': true, 'browser.headless': true,
      'browser.relay': false, 'computer.enabled': false });
    const browserSession = { cwd: browserCwd, settings: browserSettings } as never;
    const browserPrelude = createBrowserPrelude(browserSession);
    try {
      const opened = await browserPrelude.invoke({ action: 'open', name: 'kordi-blank-smoke',
        url: 'about:blank', timeout: 25 }, { session: browserSession, toolCallId: 'packaged-browser-smoke' });
      if (!opened || !('details' in opened)) throw new Error('Blank browser session did not open.');
      process.stdout.write('blank-browser-opened\n');
    } finally {
      await browserPrelude.invoke({ action: 'close', name: 'kordi-blank-smoke' },
        { session: browserSession, toolCallId: 'packaged-browser-close' }).catch(() => undefined);
      const broker = await daemonClientForProject(browserCwd).catch(() => undefined);
      await broker?.request({ op: 'stop', name: sharedBrowserDaemonName(true), timeoutMs: 5_000 }).catch(() => undefined);
      await broker?.request({ op: 'shutdown' }).catch(() => undefined);
      await closeDaemonClients();
      await rm(browserCwd, { recursive: true, force: true });
    }
  } else {
    process.stdout.write('eval-result-2;computer-capabilities-ready;browser-worker-closed\n');
  }
  process.exit(0);
}

if (!selectedWorker) {
// Reserve stdout for the framed protocol before importing the SDK or its dependencies.
const write = process.stdout.write.bind(process.stdout);
console.log = console.info = console.debug = console.warn = console.error = () => {};
const { runTurn } = await import('./runtime');
let request: RunRequest | undefined;
let sequence = 0;
let outputBytes = 0;
let terminal = false;
const controller = new AbortController();
const pending = new Map<string, { kind: 'tool_result' | 'hook_result'; resolve: (result: any) => void; reject: (error: Error) => void; cleanup: () => void }>();
function send(value: JsonObject) {
  if (terminal) return;
  const line = `${JSON.stringify({ schemaVersion: 1, ...(request ? { runId: request.runId, attemptId: request.attemptId, sequence: ++sequence } : {}), ...value })}\n`;
  outputBytes += Buffer.byteLength(line);
  if (request && outputBytes > request.limits.maxOutputBytes && !['error'].includes(value.type)) {
    finishError(new RuntimeError('output_limit', 'Run reached its output limit.'));
    controller.abort();
    return;
  }
  write(line);
}
function finishError(error: unknown) {
  send({ type: 'error', code: error instanceof RuntimeError ? error.code : 'runtime_error',
    message: error instanceof RuntimeError ? error.message : 'The agent runtime could not complete this request.' });
  terminal = true;
}
function cancelPending() {
  for (const pendingTool of pending.values()) {
    pendingTool.cleanup();
    pendingTool.reject(new RuntimeError('cancelled', 'Run cancelled.'));
  }
  pending.clear();
}
controller.signal.addEventListener('abort', cancelPending);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let execution: Promise<void> | undefined;
input.on('line', line => {
  if (terminal) return;
  try {
    if (Buffer.byteLength(line) > 32 * 1024 * 1024) throw new RuntimeError('input_limit', 'Runtime input exceeded its limit.');
    const command = parseCommand(line);
    if (command.type === 'run') {
      if (request) throw new RuntimeError('duplicate_run', 'A worker accepts only one run.');
      request = command;
      execution = runTurn(command, {
        event: event => send({ type: 'event', event }),
        hook: (name, params) => new Promise<JsonObject>((resolve, reject) => {
          if (controller.signal.aborted) return reject(new RuntimeError('cancelled', 'Run cancelled.'));
          const callId = `hook-${crypto.randomUUID()}`;
          pending.set(callId, { kind: 'hook_result', resolve, reject, cleanup: () => {} });
          send({ type: 'hook_call', callId, name, input: params });
        }),
        tool: (callId, name, params, signal) => new Promise<ToolResult>((resolve, reject) => {
          if (controller.signal.aborted || signal?.aborted) return reject(new RuntimeError('cancelled', 'Run cancelled.'));
          if (pending.has(callId)) return reject(new RuntimeError('duplicate_tool', 'Duplicate tool invocation ID.'));
          const abort = () => { pending.delete(callId); reject(new RuntimeError('cancelled', 'Tool cancelled.')); };
          signal?.addEventListener('abort', abort, { once: true });
          pending.set(callId, { kind: 'tool_result', resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
          send({ type: 'tool_call', callId, name, input: params });
        }),
      }, controller.signal).then(result => {
        send({ type: 'result', ...result });
        terminal = true;
      }).catch(finishError).finally(() => { cancelPending(); input.close(); process.stdin.pause(); });
    } else {
      if (!request || command.runId !== request.runId || command.attemptId !== request.attemptId) {
        throw new RuntimeError('stale_command', 'Runtime command does not match the active attempt.');
      }
      if (command.type === 'cancel') controller.abort();
      else {
        const call = pending.get(command.callId);
        if (!call || call.kind !== command.type) throw new RuntimeError('unknown_callback', 'No matching pending runtime callback.');
        pending.delete(command.callId); call.cleanup(); call.resolve(command.result);
      }
    }
  } catch (error) { finishError(error); controller.abort(); input.close(); }
});
input.on('close', () => { if (!terminal) controller.abort(); });
send({ type: 'ready' });
await new Promise<void>(resolve => input.once('close', resolve));
await execution;
}

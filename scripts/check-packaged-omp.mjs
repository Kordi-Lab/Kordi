#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exercise native-addon loading and the protocol without accounts or network calls.
 * --version exits before importing the runtime and cannot catch signing failures.
 */
export async function checkPackagedOmp(worker, { timeoutMs = 20_000 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'kordi-packaged-omp-'));
  try {
    return await new Promise((accept, reject) => {
      const child = spawn(resolve(worker), [], {
        cwd: home,
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, TMPDIR: home, NODE_ENV: 'production' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let ready = false;
      let terminal = false;
      let buffered = '';
      let bytes = 0;
      let failure = null;
      const fail = (message) => {
        failure ??= new Error(message);
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => fail('Packaged OMP protocol probe timed out.'), timeoutMs);
      // Never print raw child output: native loader diagnostics can contain private paths.
      const count = (chunk) => {
        bytes += chunk.length;
        if (bytes > 1_048_576) fail('Packaged OMP probe exceeded its output limit.');
      };
      child.stderr.on('data', count);
      child.stdout.on('data', (chunk) => {
        count(chunk);
        if (failure) return;
        buffered += chunk.toString();
        while (buffered.includes('\n')) {
          const end = buffered.indexOf('\n');
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          let frame;
          try { frame = JSON.parse(line); } catch { fail('Packaged OMP returned an invalid protocol frame.'); return; }
          if (frame.schemaVersion !== 1) { fail('Packaged OMP protocol version mismatch.'); return; }
          if (!ready && frame.type === 'ready') {
            ready = true;
            child.stdin.write(`${JSON.stringify({
              schemaVersion: 1, type: 'run', requestId: 'signing-probe', runId: 'signing-probe',
              attemptId: 'signing-probe', sessionId: 'signing-probe', cwd: home,
              model: { provider: 'kordi-synthetic-unknown', id: 'signing-probe' },
              auth: { kind: 'api_key', credential: 'synthetic-test-only' },
              systemPrompt: 'Synthetic packaging probe.', messages: [], tools: [], hooks: [],
              prompt: { text: 'Synthetic probe.' },
              capabilities: { ownerLocal: false, computer: false, browser: false },
              limits: { timeoutMs: 5_000, maxOutputBytes: 65_536 },
            })}\n`);
          } else if (ready && !terminal && frame.type === 'event'
            && frame.runId === 'signing-probe' && frame.attemptId === 'signing-probe'
            && frame.event?.kind === 'status' && frame.event.status === 'starting') {
            // The worker reports its startup phase before resolving the synthetic model.
          } else if (ready && !terminal && frame.type === 'error'
            && frame.code === 'model_unavailable'
            && frame.runId === 'signing-probe' && frame.attemptId === 'signing-probe') {
            terminal = true;
            child.stdin.end();
          } else { fail('Packaged OMP did not return the expected synthetic model error.'); return; }
        }
      });
      child.stdin.on('error', () => fail('Packaged OMP closed its input before completing the probe.'));
      child.on('error', () => { clearTimeout(timer); reject(new Error('Packaged OMP could not start.')); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0 || !ready || !terminal || buffered.trim()) {
          reject(new Error('Packaged OMP exited before completing the protocol probe. Check native-addon signing.'));
        } else accept({ ready: true, syntheticRequest: true });
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [option, value, ...extra] = process.argv.slice(2);
  try {
    if (!value || extra.length || !['--app-bundle', '--worker'].includes(option)) {
      throw new Error('Usage: check-packaged-omp.mjs --app-bundle <app> | --worker <executable>');
    }
    await checkPackagedOmp(option === '--app-bundle' ? join(value, 'Contents/MacOS/kordi-omp') : value);
    console.log('Packaged OMP startup and synthetic protocol request passed (no provider calls).');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

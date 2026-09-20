import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for the connection lifecycle');
}

async function launcher(context, mode = 'recover') {
  const directory = await mkdtemp(join(tmpdir(), 'kordi-connect-test-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const script = (name, source) => writeFile(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  const events = join(directory, 'events');
  await writeFile(events, '');
  const log = `const fs = require('node:fs'); const log = (event) => fs.appendFileSync(process.env.TEST_EVENTS, JSON.stringify(event) + '\\n');`;
  await script('gh', "console.log('test-developer');");
  await script('node', `${log} log({type:'doctor'});`);
  await script('pnpm', `${log} log({type:'desktop'}); process.exit(1);`);
  await script('curl', `${log}
    if (process.env.TEST_MODE === 'startup') process.exit(1);
    if (!fs.existsSync(process.env.TEST_COUNT)) process.exit(1);
    console.log(JSON.stringify({ok:true}));
  `);
  await script('sleep', `${log}
    const delay = Number(process.argv[2]); log({type:'delay', delay});
    process.on('SIGTERM', () => { log({type:'sleep-stopped'}); process.exit(0); });
    setTimeout(() => process.exit(0), process.env.TEST_MODE === 'backoff' && delay >= 2 ? 30000 : 20);
  `);
  await script('gcloud', `${log}
    const count = fs.existsSync(process.env.TEST_COUNT) ? Number(fs.readFileSync(process.env.TEST_COUNT)) + 1 : 1;
    fs.writeFileSync(process.env.TEST_COUNT, String(count));
    log({type:'tunnel', count, pid:process.pid, args:process.argv.slice(2)});
    process.on('SIGUSR1', () => process.exit(255));
    process.on('SIGTERM', () => { log({type:'tunnel-stopped', count}); process.exit(0); });
    if (process.env.TEST_MODE === 'startup' || count === 2) process.exit(255);
    setInterval(() => {}, 1000);
  `);
  const allowlist = join(directory, 'allowlist');
  await writeFile(allowlist, 'test-developer\n');
  const child = spawn('bash', [fileURLToPath(new URL('./dev-cloud-remote.sh', import.meta.url))], {
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: directory,
      KORDI_DEV_CONNECTION_MODE: 'connect', KORDI_REMOTE_DEV_GITHUB_ALLOWLIST_FILE: allowlist,
      KORDI_DEV_GCP_PROJECT: 'test-project', KORDI_DEV_SSH_ZONE: 'test-zone', KORDI_DEV_SSH_TARGET: 'test-instance',
      TEST_EVENTS: events, TEST_COUNT: join(directory, 'count'), TEST_MODE: mode,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = once(child, 'close');
  const timeout = setTimeout(() => child.kill('SIGTERM'), 10000);
  context.after(async () => {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    await rm(directory, { recursive: true, force: true });
  });
  return {
    child, closed, output: () => output,
    events: async () => (await readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}

test('shared connection survives SSH failure and a failed reconnect without launching a desktop', async (context) => {
  const fixture = await launcher(context);
  await until(() => fixture.output().includes('Shared development connection ready'));
  const first = (await fixture.events()).find((event) => event.type === 'tunnel');
  process.kill(first.pid, 'SIGUSR1');
  await until(async () => (await fixture.events()).some((event) => event.type === 'tunnel' && event.count === 3));
  assert.equal(fixture.child.exitCode, null);
  fixture.child.kill('SIGTERM');
  await fixture.closed;
  const events = await fixture.events();
  const tunnels = events.filter((event) => event.type === 'tunnel');
  assert.equal(tunnels.length, 3);
  for (const tunnel of tunnels) {
    assert.deepEqual(tunnel.args, tunnels[0].args);
    assert.ok(tunnel.args.includes('127.0.0.1:18181:127.0.0.1:18181'));
    assert.ok(tunnel.args.includes('ExitOnForwardFailure=yes'));
    assert.ok(tunnel.args.includes('--tunnel-through-iap'));
  }
  assert.deepEqual(events.filter((event) => event.type === 'delay' && event.delay >= 2).map((event) => event.delay), [2, 4]);
  assert.equal(events.filter((event) => event.type === 'doctor').length, 1);
  assert.equal(events.filter((event) => event.type === 'desktop').length, 0);
  assert.ok(events.some((event) => event.type === 'tunnel-stopped' && event.count === 3));
  assert.match(fixture.output(), /gcloud auth login in another terminal/);
});

test('stopping a shared connection during backoff cancels the retry', async (context) => {
  const fixture = await launcher(context, 'backoff');
  await until(() => fixture.output().includes('Shared development connection ready'));
  const first = (await fixture.events()).find((event) => event.type === 'tunnel');
  process.kill(first.pid, 'SIGUSR1');
  await until(async () => (await fixture.events()).some((event) => event.type === 'delay' && event.delay === 2));
  fixture.child.kill('SIGTERM');
  await fixture.closed;
  const events = await fixture.events();
  assert.ok(events.some((event) => event.type === 'sleep-stopped'));
  assert.equal(events.filter((event) => event.type === 'tunnel').length, 1);
});

test('initial tunnel failure stays fail-closed and explains authentication recovery', async (context) => {
  const fixture = await launcher(context, 'startup');
  const [code] = await fixture.closed;
  assert.equal(code, 1);
  assert.match(fixture.output(), /gcloud auth login in another terminal, then restart this command/);
  assert.equal((await fixture.events()).filter((event) => event.type === 'doctor').length, 0);
  assert.equal((await fixture.events()).filter((event) => event.type === 'tunnel').length, 1);
});

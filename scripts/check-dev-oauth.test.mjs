import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkDevOAuth } from './check-dev-oauth.mjs';

async function backend(context, { wrongPort = false, missingProvider = false, dropState = false } = {}) {
  const states = new Map();
  let created = 0;
  let origin;
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    const json = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') return json({ ok: true, server: 'kordi-cloud' });
    if (url.pathname.endsWith('/capabilities')) {
      return json({ oauthProviders: missingProvider ? ['google'] : ['google', 'github'] });
    }
    if (url.pathname.endsWith('/start')) {
      const provider = url.pathname.split('/').at(-2);
      const state = `private-probe-state-${++created}`;
      states.set(state, url.searchParams.get('redirectAfter'));
      const auth = new URL('https://example.invalid/authorize');
      auth.searchParams.set('state', state);
      auth.searchParams.set('redirect_uri', `${wrongPort ? 'http://127.0.0.1:1' : origin}/v1/cloud/auth/oauth/${provider}/callback`);
      auth.searchParams.set('client_id', 'private-client-id');
      return json({ authUrl: auth.href });
    }
    if (url.pathname.endsWith('/callback')) {
      const state = url.searchParams.get('state');
      const target = states.get(state);
      states.delete(state);
      if (!target || dropState) return json({ errorCode: 'invalid_oauth_state' }, 400);
      assert.equal(url.searchParams.get('error'), 'access_denied');
      response.writeHead(303, { location: `${target}#kordi_cloud_oauth_error=access_denied` });
      return response.end();
    }
    json({}, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { origin, states, created: () => created };
}

test('doctor verifies both providers and consumes only its own temporary states', async (context) => {
  const fixture = await backend(context);
  fixture.states.set('existing-user-login', 'unchanged');
  const result = await checkDevOAuth(fixture.origin);
  assert.equal(result.callbacks.length, 2);
  assert.equal(fixture.created(), 2);
  assert.deepEqual([...fixture.states.entries()], [['existing-user-login', 'unchanged']]);
});

test('doctor detects the wrong-backend callback without following it or leaking state', async (context) => {
  const fixture = await backend(context, { wrongPort: true });
  await assert.rejects(checkDevOAuth(fixture.origin), (error) => {
    assert.match(error.message, /callback routing does not match/);
    assert.match(error.message, /KORDI_DEBUG_PUBLIC_API_PORT=/);
    assert.ok(error.message.includes(`${fixture.origin}/v1/cloud/auth/oauth/google/callback`));
    assert.ok(error.message.includes(`${fixture.origin}/v1/cloud/auth/oauth/github/callback`));
    assert.doesNotMatch(error.message, /private-probe-state|private-client-id/);
    return true;
  });
  assert.equal(fixture.states.size, 0);
});

test('doctor refuses an incomplete provider setup before starting OAuth', async (context) => {
  const fixture = await backend(context, { missingProvider: true });
  await assert.rejects(checkDevOAuth(fixture.origin), /separate development Google and GitHub/);
  assert.equal(fixture.created(), 0);
});

test('doctor detects an inconsistent state store', async (context) => {
  const fixture = await backend(context, { dropState: true });
  await assert.rejects(checkDevOAuth(fixture.origin), /state round trip/);
});

test('doctor never contacts production or follows an unexpected API redirect', async () => {
  for (const origin of ['https://kordi.ai', 'http://example.com', 'http://user:secret@localhost:1234', 'http://localhost:1234/path']) {
    await assert.rejects(checkDevOAuth(origin, { fetchImpl: () => assert.fail('network must not run') }), /loopback/);
  }
  await assert.rejects(checkDevOAuth('http://127.0.0.1:1234', {
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://example.com' } });
    },
  }), /HTTP 302/);
});

test('remote launcher rejects mismatched callbacks before opening the desktop and cleans up its tunnel', async (context) => {
  const fixture = await backend(context, { wrongPort: true });
  const directory = await mkdtemp(join(tmpdir(), 'kordi-oauth-launcher-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const script = async (name, source) => writeFile(join(bin, name), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  await script('gh', "console.log('test-developer');");
  await script('pnpm', "require('fs').writeFileSync(process.env.TEST_DESKTOP_MARKER, 'started');");
  await script('gcloud', "const fs = require('fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.env.TEST_TUNNEL_MARKER, 'stopped'); process.exit(0); }); fs.writeFileSync(process.env.TEST_TUNNEL_MARKER, 'started'); setInterval(() => {}, 1000);");
  await script('curl', "const fs = require('fs'); if (!fs.existsSync(process.env.TEST_CURL_MARKER)) { fs.writeFileSync(process.env.TEST_CURL_MARKER, 'checked'); process.exit(1); } if (!fs.existsSync(process.env.TEST_TUNNEL_MARKER)) process.exit(1); console.log(JSON.stringify({ok:true,server:'kordi-cloud'}));");
  const allowlist = join(directory, 'allowlist');
  await writeFile(allowlist, 'test-developer\n');
  const child = spawn('bash', [fileURLToPath(new URL('./dev-cloud-remote.sh', import.meta.url))], {
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: directory,
      KORDI_REMOTE_DEV_GITHUB_ALLOWLIST_FILE: allowlist,
      KORDI_DEV_GCP_PROJECT: 'test-project', KORDI_DEV_SSH_ZONE: 'test-zone', KORDI_DEV_SSH_TARGET: 'test-instance',
      KORDI_DEV_LOCAL_API_PORT: new URL(fixture.origin).port,
      KORDI_DEV_DESKTOP_PORT: '1455', KORDI_DEV_DESKTOP_PROFILE: 'oauth-test',
      TEST_DESKTOP_MARKER: join(directory, 'desktop'), TEST_TUNNEL_MARKER: join(directory, 'tunnel'),
      TEST_CURL_MARKER: join(directory, 'curl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 8000);
  context.after(() => clearTimeout(timer));
  const [code] = await once(child, 'close');
  assert.equal(code, 1, stderr);
  assert.match(stderr, /callback routing does not match/);
  await assert.rejects(readFile(join(directory, 'desktop')), { code: 'ENOENT' });
  assert.equal(await readFile(join(directory, 'tunnel'), 'utf8'), 'stopped');
});

test('two shared previews use separate profiles without starting or stopping the shared connection', async (context) => {
  const fixture = await backend(context);
  const directory = await mkdtemp(join(tmpdir(), 'kordi-shared-preview-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const script = async (name, source) => writeFile(join(bin, name), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  await script('gh', "console.log('test-developer');");
  await script('curl', "console.log(JSON.stringify({ok:true,server:'kordi-cloud'}));");
  await script('gcloud', "require('fs').writeFileSync(process.env.TEST_TUNNEL_MARKER, 'unexpected'); process.exit(1);");
  await script('pnpm', "require('fs').writeFileSync(process.env.TEST_DESKTOP_MARKER, JSON.stringify({args:process.argv.slice(2),origin:process.env.VITE_KORDI_CLOUD_API_BASE,profile:process.env.VITE_KORDI_DEV_PROFILE}));");
  const allowlist = join(directory, 'allowlist');
  await writeFile(allowlist, 'test-developer\n');
  await Promise.all(['feature-a', 'feature-b'].map(async (profile, index) => {
    const marker = join(directory, profile);
    const child = spawn('bash', [fileURLToPath(new URL('./dev-cloud-remote.sh', import.meta.url)), '--profile', profile, '--port', String(1456 + index)], {
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: directory,
        KORDI_REMOTE_DEV_GITHUB_ALLOWLIST_FILE: allowlist,
        KORDI_DEV_CONNECTION_MODE: 'shared', KORDI_DEV_LOCAL_API_PORT: new URL(fixture.origin).port,
        TEST_DESKTOP_MARKER: marker, TEST_TUNNEL_MARKER: join(directory, 'tunnel'),
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 8000);
    context.after(() => clearTimeout(timer));
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    const launched = JSON.parse(await readFile(marker, 'utf8'));
    assert.ok(launched.args.includes(profile));
    assert.ok(launched.args.includes(String(1456 + index)));
    assert.equal(launched.origin, fixture.origin);
    assert.equal(launched.profile, 'community');
  }));
  await assert.rejects(readFile(join(directory, 'tunnel')), { code: 'ENOENT' });
  await checkDevOAuth(fixture.origin);
});

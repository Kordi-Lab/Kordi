#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an explicit HTTP loopback API origin for development checks.');
  }
  return url.origin;
}

export async function checkDevOAuth(apiBase, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const origin = loopbackOrigin(apiBase);
  const request = async (path) => {
    try {
      return await fetchImpl(`${origin}${path}`, {
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('Development API request failed. Check the task-owned tunnel and backend.');
    }
  };
  const read = async (path) => {
    const response = await request(path);
    if (!response.ok) throw new Error(`Development preflight request failed (HTTP ${response.status}).`);
    try { return await response.json(); } catch { throw new Error('Development API returned invalid JSON.'); }
  };
  const health = await read('/health');
  if (health.ok !== true || health.server !== 'kordi-cloud') {
    throw new Error('The selected local port is not a healthy Kordi backend.');
  }
  const capabilities = await read('/v1/cloud/auth/capabilities');
  if (!['google', 'github'].every((provider) => capabilities.oauthProviders?.includes(provider))) {
    throw new Error('Configure separate development Google and GitHub OAuth clients on this backend.');
  }

  const problems = [];
  const callbacks = [];
  for (const provider of ['google', 'github']) {
    const callbackPath = `/v1/cloud/auth/oauth/${provider}/callback`;
    const expected = `${origin}${callbackPath}`;
    const redirectAfter = `${origin}/__kordi_oauth_preflight`;
    const started = await read(`/v1/cloud/auth/oauth/${provider}/start?${new URLSearchParams({ redirectAfter })}`);
    let authUrl;
    try { authUrl = new URL(started.authUrl); } catch { throw new Error('OAuth start returned an invalid authorization URL.'); }
    const state = authUrl.searchParams.get('state');
    if (!state) throw new Error('OAuth start did not create a state.');
    // Consume only this probe's state on the backend that created it. Never
    // follow a provider URL or send the state to a possibly misrouted callback.
    const cancelled = await request(`${callbackPath}?${new URLSearchParams({ state, error: 'access_denied' })}`);
    let returned;
    try { returned = new URL(cancelled.headers.get('location')); } catch { /* checked below */ }
    if (cancelled.status !== 303 || returned?.origin !== origin
        || returned.pathname !== '/__kordi_oauth_preflight'
        || new URLSearchParams(returned.hash.slice(1)).get('kordi_cloud_oauth_error') !== 'access_denied') {
      throw new Error('The development backend could not complete its own OAuth state round trip.');
    }
    if (authUrl.searchParams.get('redirect_uri') !== expected) {
      problems.push(`${provider}: callback must be ${expected}`);
    }
    callbacks.push(expected);
  }
  if (problems.length) {
    throw new Error([
      'OAuth callback routing does not match this development tunnel.', ...problems,
      `Set KORDI_DEBUG_PUBLIC_API_PORT=${new URL(origin).port || '80'} on the owning development stack,`,
      'recreate its cloud-server, and register these callbacks in the development OAuth applications.',
      'Use a separate stack when changing this configuration would interrupt another task.',
    ].join('\n'));
  }
  return { origin, callbacks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length !== 2 || args[0] !== '--api-base') {
    console.error('Usage: pnpm doctor:dev --api-base http://127.0.0.1:<task-api-port>');
    process.exitCode = 2;
  } else {
    try {
      const { origin } = await checkDevOAuth(args[1]);
      console.log(`[kordi-dev] Healthy backend, both OAuth providers, matching callbacks, and one-use state verified at ${origin}.`);
      console.log('[kordi-dev] Provider-console registrations and account consent still require an interactive sign-in.');
    } catch (error) {
      console.error(`[kordi-dev] ${error.message}`);
      process.exitCode = 1;
    }
  }
}

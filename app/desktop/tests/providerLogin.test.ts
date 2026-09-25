import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptsLoginCallback,
  createCloudProviderLoginClient,
  initialProviderLoginView,
  loginCallbackFallbackHint,
  loginCallbackHint,
  loginCallbackPortBusyHint,
  loginCallbackReceivedText,
  parseLoginUserCode,
  providerLoginErrorFromResponse,
  providerLoginErrorMessage,
  providerLoginReducer,
  ProviderLoginError,
  type ProviderLoginErrorCode,
  type ProviderLoginSession,
  type ProviderLoginView,
} from '../src/features/cloud/providerLogin';

function session(overrides: Partial<ProviderLoginSession>): ProviderLoginSession {
  return { sessionId: 'login_1', status: 'running', step: null, auth: null, version: 1, ...overrides };
}

function apply(...sessions: ProviderLoginSession[]): ProviderLoginView {
  return sessions.reduce(
    (view, next) => providerLoginReducer(view, { type: 'session', session: next }),
    providerLoginReducer(initialProviderLoginView, { type: 'start' }),
  );
}

test('open-url steps wait for the browser and keep the sign-in link', () => {
  const view = apply(session({
    step: { type: 'open-url', url: 'https://sign-in.example/a', launchUrl: 'https://sign-in.example/launch', instructions: 'Complete login in your browser.' },
    auth: { url: 'https://sign-in.example/a', launchUrl: 'https://sign-in.example/launch', instructions: 'Complete login in your browser.' },
  }));
  assert.equal(view.phase, 'waiting');
  assert.equal(view.auth?.launchUrl, 'https://sign-in.example/launch');
  assert.equal(view.statusLine, 'Complete login in your browser.');
  assert.equal(view.input, null);
});

test('device codes are read from the auth instructions and survive later steps', () => {
  const opened = session({
    step: { type: 'open-url', url: 'https://sign-in.example/device', instructions: 'Enter code: PRVW-2468' },
    auth: { url: 'https://sign-in.example/device', instructions: 'Enter code: PRVW-2468' },
  });
  const progress = session({ version: 2, step: { type: 'progress', message: 'Confirming sign-in…' }, auth: opened.auth });
  const view = apply(opened, progress);
  assert.equal(view.userCode, 'PRVW-2468');
  assert.equal(view.statusLine, 'Confirming sign-in…');
  assert.equal(view.auth?.url, 'https://sign-in.example/device');
  assert.equal(parseLoginUserCode('Visit the page and enter the code ABCD-1234 to continue.'), 'ABCD-1234');
  assert.equal(parseLoginUserCode('Complete login in your browser.'), null);
});

test('prompt, paste-code and api-key steps ask for input with the right masking', () => {
  const prompt = apply(session({ status: 'awaiting-input', step: { type: 'prompt', message: 'Paste your token', placeholder: 'tok_', secret: true } }));
  assert.equal(prompt.phase, 'input');
  assert.deepEqual(prompt.input, { kind: 'prompt', message: 'Paste your token', placeholder: 'tok_', secret: true, allowEmpty: false, authUrl: null });

  const paste = apply(session({ status: 'awaiting-input', step: { type: 'paste-code', instructions: 'Paste the final redirect URL.' } }));
  assert.equal(paste.input?.kind, 'paste-code');
  assert.equal(paste.input?.secret, false);
  assert.equal(paste.input?.message, 'Paste the final redirect URL.');

  const key = apply(session({ status: 'awaiting-input', step: { type: 'api-key', instructions: 'Copy a key.', placeholder: 'gsk_', authUrl: 'https://keys.example' } }));
  assert.equal(key.input?.kind, 'api-key');
  assert.equal(key.input?.secret, true);
  assert.equal(key.input?.authUrl, 'https://keys.example');
  assert.equal(providerLoginReducer(key, { type: 'submit' }).statusLine, 'Verifying with OMP…');
  assert.equal(providerLoginReducer(prompt, { type: 'submit' }).statusLine, 'Sending to OMP…');
});

test('progress steps update one status line and stale versions are ignored', () => {
  const first = apply(session({ version: 3, step: { type: 'progress', message: 'Exchanging code…' } }));
  assert.equal(first.phase, 'waiting');
  assert.equal(first.statusLine, 'Exchanging code…');
  const stale = providerLoginReducer(first, { type: 'session', session: session({ version: 2, step: { type: 'progress', message: 'Older' } }) });
  assert.equal(stale, first);
});

test('terminal states: completed carries the snapshot, failed explains, cancelled stops', () => {
  const snapshot = { snapshotId: 'snap_1', provider: 'groq', authChoice: 'omp-api-key:1', label: 'Work' };
  // Like the server, a completed state carries no version.
  const completed = apply(session({ status: 'completed', snapshot, version: null }));
  assert.equal(completed.phase, 'completed');
  assert.deepEqual(completed.snapshot, snapshot);

  const failed = apply(session({ status: 'failed', error: 'login_failed', reason: 'access_denied' }));
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.error?.code, 'login_failed');
  assert.match(failed.error?.message ?? '', /access denied/);

  const cancelled = apply(session({ status: 'cancelled', version: null }));
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(providerLoginReducer(cancelled, { type: 'reset' }), initialProviderLoginView);
  assert.equal(providerLoginReducer(failed, { type: 'cancelled' }).phase, 'cancelled');
});

test('every server error code maps to its own recovery text', () => {
  const cases: Array<[number, ProviderLoginErrorCode]> = [
    [404, 'login_not_found'],
    [410, 'login_expired'],
    [502, 'login_failed'],
    [422, 'login_unsupported'],
    [400, 'invalid_login_input'],
    [429, 'rate_limited'],
    [503, 'omp_unavailable'],
    [503, 'provider_auth_not_configured'],
    [503, 'omp_busy'],
  ];
  const messages = new Set<string>();
  for (const [status, code] of cases) {
    const error = providerLoginErrorFromResponse(status, { errorCode: code, reason: code === 'login_failed' ? 'provider_rejected' : undefined });
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.message, providerLoginErrorMessage(code, error.reason));
    messages.add(error.message);
  }
  assert.equal(messages.size, cases.length, 'recovery text must differ per code');
  assert.match(providerLoginErrorFromResponse(502, { error: { code: 'login_failed', reason: 'timeout' } }).message, /timeout/);
  assert.equal(providerLoginErrorFromResponse(410, {}).code, 'login_expired');
  assert.equal(providerLoginErrorFromResponse(500, 'not json').code, 'unknown');
  assert.equal(providerLoginErrorFromResponse(503, { errorCode: 'something_new' }).code, 'unknown', 'an unknown 503 is not OMP missing');
  assert.equal(providerLoginErrorFromResponse(503, {}).code, 'unknown');
});

test('input errors keep the field open while other errors end the flow', () => {
  const prompt = apply(session({ status: 'awaiting-input', step: { type: 'prompt', message: 'Token', secret: true } }));
  const invalid = providerLoginReducer(providerLoginReducer(prompt, { type: 'submit' }), { type: 'error', error: new ProviderLoginError('invalid_login_input', 400) });
  assert.equal(invalid.phase, 'input');
  assert.equal(invalid.error?.code, 'invalid_login_input');
  const busy = providerLoginReducer(prompt, { type: 'error', error: new ProviderLoginError('omp_busy', 503) });
  assert.equal(busy.phase, 'failed');
  assert.equal(busy.input, null);
});

test('the HTTP client follows the session contract and never runs without a Kordi session', async () => {
  const calls: Array<{ url: string; method: string; body: string | null; auth: string | null }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null, auth: headers.get('authorization') });
    if (String(url).endsWith('/cancel')) return new Response(null, { status: 204 });
    if (String(url).endsWith('/input')) return new Response(JSON.stringify({ errorCode: 'invalid_login_input' }), { status: 400 });
    return new Response(JSON.stringify(session({ status: 'awaiting-input', step: { type: 'api-key' }, version: 2 })), { status: 200 });
  };
  const client = createCloudProviderLoginClient({ baseUrl: () => 'http://127.0.0.1:9', fetchImpl, token: async () => 'synthetic' });
  const started = await client.start({ provider: 'groq', label: 'Work', method: 'api-key' });
  assert.equal(started.version, 2);
  await client.poll('login_1', 2);
  await assert.rejects(client.submit('login_1', 'value'), (caught: unknown) => caught instanceof ProviderLoginError && caught.code === 'invalid_login_input');
  await client.cancel('login_1');
  assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`), [
    'POST /v1/cloud/agent-provider-auth/login/start',
    'GET /v1/cloud/agent-provider-auth/login/login_1?wait=25&after=2',
    'POST /v1/cloud/agent-provider-auth/login/login_1/input',
    'POST /v1/cloud/agent-provider-auth/login/login_1/cancel',
  ]);
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { provider: 'groq', label: 'Work', method: 'api-key' });
  assert.ok(calls.every((call) => call.auth === 'Bearer synthetic'));

  const signedOut = createCloudProviderLoginClient({ baseUrl: () => 'http://127.0.0.1:9', fetchImpl, token: async () => null });
  await assert.rejects(signedOut.start({ provider: 'groq', label: 'Work' }), (caught: unknown) => caught instanceof ProviderLoginError && caught.code === 'not_signed_in');
  assert.equal(calls.length, 4);
});

test('a captured browser redirect is announced and submitted without entering the transcript', () => {
  const opened = session({ auth: { url: 'https://sign-in.example/authorize' }, step: { type: 'open-url', url: 'https://sign-in.example/authorize' } });
  const paste = session({ status: 'awaiting-input', step: { type: 'paste-code' }, version: 2 });
  assert.equal(acceptsLoginCallback(opened), false, 'nothing takes the redirect before OMP asks for it');
  assert.equal(acceptsLoginCallback(paste), true);
  assert.equal(acceptsLoginCallback(session({ status: 'awaiting-input', step: { type: 'prompt', message: 'Paste the authorization code (or full redirect URL):' } })), true);
  assert.equal(acceptsLoginCallback(session({ status: 'awaiting-input', step: { type: 'prompt', message: 'Google Cloud project ID' } })), false);

  let view = providerLoginReducer(apply(opened), { type: 'callback', state: 'listening' });
  assert.equal(view.callback, 'listening');
  view = providerLoginReducer(view, { type: 'session', session: paste });
  assert.equal(loginCallbackHint(view), null, 'the paste field needs no hint while Kordi listens');
  view = providerLoginReducer(view, { type: 'callback', state: 'received' });
  view = providerLoginReducer(view, { type: 'submit' });
  assert.equal(view.phase, 'submitting');
  assert.deepEqual(view.transcript, [{ type: 'progress', text: loginCallbackReceivedText }]);
  assert.doesNotMatch(JSON.stringify(view), /localhost|code=/);
  view = providerLoginReducer(view, { type: 'session', session: session({ status: 'completed', version: null, snapshot: { snapshotId: 'snap_1', provider: 'openai-codex', authChoice: 'cloud-login:1', label: 'Studio' } }) });
  assert.equal(view.phase, 'completed');
  assert.equal(view.callback, 'received');
});

test('when the redirect cannot be captured the paste field keeps a hint', () => {
  const paste = session({ status: 'awaiting-input', step: { type: 'paste-code' }, auth: { url: 'https://sign-in.example/authorize' } });
  const view = providerLoginReducer(apply(paste), { type: 'callback', state: 'unavailable' });
  assert.equal(view.phase, 'input');
  assert.equal(view.input?.kind, 'paste-code');
  assert.equal(loginCallbackHint(view), loginCallbackFallbackHint);
  assert.equal(loginCallbackFallbackHint, "After you approve in the browser it will land on a localhost page that cannot load. Copy that page's full address and paste it here.");
  const keyStep = providerLoginReducer(apply(session({ status: 'awaiting-input', step: { type: 'api-key' } })), { type: 'callback', state: 'unavailable' });
  assert.equal(loginCallbackHint(keyStep), null);
  assert.equal(providerLoginReducer(view, { type: 'start' }).callback, 'off', 'a new sign-in listens again');
});

test('a completed sign-in with the server null version is shown, and nothing later hides it', () => {
  const snapshot = { snapshotId: 'snap_2', provider: 'openai-codex', authChoice: 'cloud-login:2', label: 'Studio' };
  const waiting = apply(
    session({ version: 3, step: { type: 'progress', message: 'Finishing sign-in…' } }),
    // A claim in progress: the server records it itself and sends no version.
    session({ version: null, step: { type: 'progress', message: 'Saving the account.' } }),
  );
  assert.equal(waiting.phase, 'waiting');
  assert.equal(waiting.statusLine, 'Saving the account.');
  assert.equal(waiting.version, 3, 'a null version keeps the last numbered one');

  const completed = providerLoginReducer(waiting, { type: 'session', session: session({ status: 'completed', version: null, snapshot }) });
  assert.equal(completed.phase, 'completed', 'null < 3 must not drop the result');
  assert.deepEqual(completed.snapshot, snapshot);
  assert.equal(completed.version, 3);

  const late = session({ version: 9, status: 'awaiting-input', step: { type: 'paste-code' } });
  assert.equal(providerLoginReducer(completed, { type: 'session', session: late }), completed);
  assert.equal(providerLoginReducer(completed, { type: 'cancelled' }), completed, 'Cancel never says nothing was saved');
  assert.equal(providerLoginReducer(completed, { type: 'error', error: new ProviderLoginError('network_error') }), completed);

  // A cancel that raced the result: the server answers the cancel with the completed state.
  const cancelled = providerLoginReducer(waiting, { type: 'cancelled' });
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(providerLoginReducer(cancelled, { type: 'session', session: late }), cancelled);
  assert.equal(providerLoginReducer(cancelled, { type: 'session', session: session({ status: 'completed', version: null, snapshot }) }).phase, 'completed');
});

test('the unchanged state a long poll returns keeps an error and a submit in progress', () => {
  const prompt = session({ version: 2, status: 'awaiting-input', step: { type: 'prompt', message: 'Token', secret: true } });
  const asked = apply(prompt);
  const rejected = providerLoginReducer(providerLoginReducer(asked, { type: 'submit' }), { type: 'error', error: new ProviderLoginError('invalid_login_input', 400) });
  const afterPoll = providerLoginReducer(rejected, { type: 'session', session: prompt });
  assert.equal(afterPoll.phase, 'input');
  assert.equal(afterPoll.error?.code, 'invalid_login_input', 'OMP did not accept that value stays visible');

  const submitting = providerLoginReducer(asked, { type: 'submit' });
  assert.equal(providerLoginReducer(submitting, { type: 'session', session: prompt }).phase, 'submitting');

  const offline = providerLoginReducer(submitting, { type: 'error', error: new ProviderLoginError('network_error') });
  const stillFailed = providerLoginReducer(offline, { type: 'session', session: prompt });
  assert.equal(stillFailed.phase, 'failed', 'a network failure does not flip back to the input step');
  assert.equal(stillFailed.error?.code, 'network_error');

  // A newer state is real progress and replaces the error.
  const next = providerLoginReducer(offline, { type: 'session', session: session({ version: 3, step: { type: 'progress', message: 'Finishing sign-in…' } }) });
  assert.equal(next.phase, 'waiting');
  assert.equal(next.error, null);
});

test('only a missing or unconfigured backend turns OMP off; a worker hiccup is retryable', () => {
  const missing = providerLoginErrorFromResponse(503, { errorCode: 'provider_auth_not_configured' });
  assert.equal(missing.ompUnavailable, true);
  const oldServer = providerLoginErrorFromResponse(404, null);
  assert.equal(oldServer.code, 'provider_auth_not_configured');
  assert.equal(oldServer.ompUnavailable, true);
  const restarting = providerLoginErrorFromResponse(503, { errorCode: 'omp_unavailable' });
  assert.equal(restarting.code, 'omp_unavailable');
  assert.equal(restarting.ompUnavailable, false);
  assert.match(restarting.message, /Try again/);
  const failed = providerLoginReducer(apply(session({ version: 2 })), { type: 'error', error: restarting });
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.error?.code, 'omp_unavailable');
});

test('a busy loopback port names the port and keeps the paste field', () => {
  const opened = session({ auth: { url: 'https://sign-in.example/authorize' }, step: { type: 'open-url', url: 'https://sign-in.example/authorize' } });
  const busy = providerLoginReducer(apply(opened), { type: 'callback', state: 'port-busy', port: 1455 });
  assert.equal(busy.callback, 'port-busy');
  assert.equal(loginCallbackHint(busy), loginCallbackPortBusyHint(1455), 'explained before OMP asks for the link');
  assert.equal(loginCallbackPortBusyHint(1455), 'Port 1455 is in use on this Mac. Close the program using it, or paste the callback link below.');
  const paste = providerLoginReducer(busy, { type: 'session', session: session({ status: 'awaiting-input', step: { type: 'paste-code' }, version: 2 }) });
  assert.equal(paste.phase, 'input');
  assert.equal(paste.input?.kind, 'paste-code');
  assert.equal(loginCallbackHint(paste), loginCallbackPortBusyHint(1455));
  const detail = providerLoginReducer(busy, { type: 'session', session: session({ status: 'awaiting-input', step: { type: 'prompt', message: 'Google Cloud project ID' }, version: 2 }) });
  assert.equal(loginCallbackHint(detail), null, 'a prompt for another detail gets no port hint');
  assert.equal(providerLoginReducer(busy, { type: 'start' }).callbackPort, null);
});

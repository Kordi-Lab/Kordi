import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProviderLoginError, type ProviderLoginClient, type ProviderLoginSession } from '../src/features/cloud/providerLogin';
import { pollProviderLogin } from '../src/features/cloud/providerLoginPoll';

function session(overrides: Partial<ProviderLoginSession>): ProviderLoginSession {
  return { sessionId: 'login_1', status: 'running', step: null, auth: null, version: 1, ...overrides };
}

/** A client whose polls answer from a script: a session, or an error to throw. */
function scriptedClient(script: Array<ProviderLoginSession | Error>) {
  const afters: number[] = [];
  const client: ProviderLoginClient = {
    start: async () => session({}),
    poll: async (_id, after) => {
      afters.push(after);
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      return next;
    },
    submit: async () => null,
    cancel: async () => null,
  };
  return { client, afters };
}

test('transient failures are retried with backoff until the sign-in completes', async () => {
  const snapshot = { snapshotId: 'snap_1', provider: 'openai-codex', authChoice: 'cloud-login:1', label: 'Studio' };
  const { client, afters } = scriptedClient([
    new ProviderLoginError('omp_unavailable', 503),
    new ProviderLoginError('network_error'),
    session({ version: 2, status: 'awaiting-input', step: { type: 'paste-code' } }),
    new ProviderLoginError('omp_unavailable', 503),
    session({ version: null, step: { type: 'progress', message: 'Saving the account.' } }),
    session({ version: null, status: 'completed', snapshot }),
  ]);
  const seen: ProviderLoginSession[] = [];
  const waits: number[] = [];
  const started = Date.now();
  await pollProviderLogin(client, session({ version: 1 }), {
    signal: new AbortController().signal,
    onSession: (next) => { seen.push(next); waits.push(Date.now() - started); },
    retryDelaysMs: [5, 10],
  });
  assert.deepEqual(seen.map((next) => next.status), ['awaiting-input', 'running', 'completed']);
  assert.deepEqual(afters, [1, 1, 1, 2, 2, 2], 'a null version never moves `after`');
  assert.ok(waits[0] >= 15, 'both backoff delays elapsed before the first answer');
});

test('after the last retry a transient failure is thrown so the page can offer to try again', async () => {
  const { client, afters } = scriptedClient([
    new ProviderLoginError('omp_unavailable', 503),
    new ProviderLoginError('omp_unavailable', 503),
    new ProviderLoginError('omp_unavailable', 503),
  ]);
  await assert.rejects(
    pollProviderLogin(client, session({}), { signal: new AbortController().signal, onSession: () => undefined, retryDelaysMs: [1, 1] }),
    (caught: unknown) => caught instanceof ProviderLoginError && caught.code === 'omp_unavailable' && !caught.ompUnavailable,
  );
  assert.equal(afters.length, 3);
});

test('other failures are not retried, and an abort or stop ends polling quietly', async () => {
  const expired = scriptedClient([new ProviderLoginError('login_expired', 410)]);
  await assert.rejects(
    pollProviderLogin(expired.client, session({}), { signal: new AbortController().signal, onSession: () => undefined, retryDelaysMs: [1] }),
    (caught: unknown) => caught instanceof ProviderLoginError && caught.code === 'login_expired',
  );
  assert.equal(expired.afters.length, 1);

  const controller = new AbortController();
  const aborted = scriptedClient([new ProviderLoginError('omp_unavailable', 503)]);
  const polling = pollProviderLogin(aborted.client, session({}), { signal: controller.signal, onSession: () => undefined, retryDelaysMs: [60_000] });
  setTimeout(() => controller.abort(), 5);
  await polling;
  assert.equal(aborted.afters.length, 1, 'an abort during the backoff ends without another poll');

  let stopped = false;
  const stopping = scriptedClient([session({ version: 2 }), session({ version: 3 })]);
  await pollProviderLogin(stopping.client, session({}), {
    signal: new AbortController().signal,
    onSession: () => { stopped = true; },
    stopped: () => stopped,
  });
  assert.equal(stopping.afters.length, 1);
});

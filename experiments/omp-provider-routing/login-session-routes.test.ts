import { describe, expect, test } from 'bun:test';
import * as AIError from '@oh-my-pi/pi-ai/error';
import { createWorkerFetch } from './live-server';
import type { LoginSnapshot } from './login-sessions';
import { fakeRegistry, manager, policy, promptLogin, until } from './login-test-fixtures';

// HTTP routes: bearer gate, route contract, and fixed error bodies.

describe('HTTP routes', () => {
  const token = 'synthetic-worker-token';

  function post(path: string, body: unknown, auth = `Bearer ${token}`) {
    return new Request(`http://worker${path}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  test('login routes sit behind the worker bearer', async () => {
    const fetchWorker = createWorkerFetch(token, manager(fakeRegistry({ acme: promptLogin() })));
    const sessionId = crypto.randomUUID();
    expect((await fetchWorker(post('/login/start', { provider: 'acme', sessionId }, 'Bearer wrong'))).status).toBe(401);
    expect((await fetchWorker(new Request(`http://worker/login/${sessionId}`))).status).toBe(401);
    const started = await fetchWorker(post('/login/start', { provider: 'acme', sessionId }));
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ sessionId, status: 'awaiting-input', error: null });
  });

  test('start, poll, input, and claim follow the route contract', async () => {
    const fetchWorker = createWorkerFetch(token, manager(fakeRegistry({ acme: promptLogin() })));
    const auth = { authorization: `Bearer ${token}` };
    const sessionId = crypto.randomUUID();

    const started = await fetchWorker(post('/login/start', { provider: 'acme', sessionId }));
    expect(started.status).toBe(202);
    const first = await started.json() as LoginSnapshot;
    expect(first.step?.type).toBe('prompt');

    const polled = await fetchWorker(new Request(`http://worker/login/${sessionId}?wait=0`, { headers: auth }));
    expect(polled.status).toBe(200);

    const input = await fetchWorker(post(`/login/${sessionId}/input`, { value: 'synthetic-token' }));
    expect(input.status).toBe(202);
    let snapshot = await input.json() as LoginSnapshot;
    while (snapshot.status === 'running' || snapshot.status === 'awaiting-input') {
      const next = await fetchWorker(new Request(`http://worker/login/${sessionId}?wait=5&after=${snapshot.version}`, { headers: auth }));
      snapshot = await next.json() as LoginSnapshot;
    }

    expect(snapshot.status).toBe('completed');
    const claimed = await fetchWorker(post(`/login/${sessionId}/claim`, {}));
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ provider: 'acme', material: { apiMode: 'acme-oauth', accessToken: 'synthetic-token' } });
    const again = await fetchWorker(post(`/login/${sessionId}/claim`, {}));
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: 'not_found' });
    expect((await fetchWorker(post('/login/unknown/route/here', {}))).status).toBe(404);
  });

  test('error responses carry fixed codes and never contain input values', async () => {
    const leaked = 'synthetic-secret-value';
    const sessions = manager(fakeRegistry({
      acme: promptLogin(),
      'fake-fail': {
        policy: policy({}),
        login: async (controller) => {
          const pasted = await controller.onPrompt!({ message: 'Paste a code', secret: true });
          throw new AIError.OAuthError(`token exchange failed: 400 {"error":"bad code ${pasted}"}`, { kind: 'token-exchange' });
        },
      },
    }));
    const fetchWorker = createWorkerFetch(token, sessions);
    const acmeId = crypto.randomUUID();
    await fetchWorker(post('/login/start', { provider: 'acme', sessionId: acmeId }));

    const responses = [
      await fetchWorker(post(`/login/${acmeId}/input`, { value: `${leaked}${'x'.repeat(17_000)}` })),
      await fetchWorker(post(`/login/${acmeId}/input`, { value: 42 })),
      await fetchWorker(post(`/login/${acmeId}/input`, `{"value": "${leaked}"`)),
      await fetchWorker(post('/login/start', { provider: leaked, sessionId: crypto.randomUUID() })),
      await fetchWorker(post(`/login/${crypto.randomUUID()}/input`, { value: leaked })),
    ];
    expect(responses.map((response) => response.status)).toEqual([413, 400, 400, 422, 404]);
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain(leaked);
      expect(Object.keys(JSON.parse(text))).toEqual(['error']);
    }

    const failId = crypto.randomUUID();
    await fetchWorker(post('/login/start', { provider: 'fake-fail', sessionId: failId }));
    await fetchWorker(post(`/login/${failId}/input`, { value: leaked }));
    const failed = await until(sessions, failId, (snapshot) => snapshot.status === 'failed');
    expect(failed.error).toBe('provider_rejected');
    const text = await (await fetchWorker(new Request(`http://worker/login/${failId}`, {
      headers: { authorization: `Bearer ${token}` },
    }))).text();
    expect(text).not.toContain(leaked);
    sessions.close();
  });

});

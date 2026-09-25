import { describe, expect, test } from 'bun:test';
import * as AIError from '@oh-my-pi/pi-ai/error';
import { classifyLoginError } from './login-sessions';
import { fakeRegistry, manager, policy, promptLogin, SYNTHETIC_CREDENTIALS, until } from './login-test-fixtures';

// Session store: cancel, idle expiry, capacity, start validation, and fixed classifications.

describe('session lifecycle', () => {
  test('cancel aborts the login, rejects later input, and discards unclaimed credentials', async () => {
    const registry = fakeRegistry({ acme: promptLogin(), done: { policy: policy({}), login: async () => SYNTHETIC_CREDENTIALS } });
    const sessions = manager(registry);
    const sessionId = crypto.randomUUID();
    await sessions.start({ provider: 'acme', sessionId });
    const signal = registry.controllers[0]!.signal!;
    expect(signal.aborted).toBe(false);

    const cancelled = sessions.cancel(sessionId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBeNull();
    expect(signal.aborted).toBe(true);
    expect(() => sessions.input(sessionId, 'synthetic-late-token')).toThrow('no_pending_input');
    expect(() => sessions.claim(sessionId)).toThrow('not_completed');
    expect(sessions.cancel(sessionId).status).toBe('cancelled');

    const completedId = crypto.randomUUID();
    await sessions.start({ provider: 'done', sessionId: completedId });
    await until(sessions, completedId, (snapshot) => snapshot.status === 'completed');
    expect(sessions.cancel(completedId).status).toBe('cancelled');
    expect(() => sessions.claim(completedId)).toThrow('not_completed');
  });

  test('sessions expire 15 minutes after the last activity and abort their login', async () => {
    let clock = 1_000_000;
    const registry = fakeRegistry({ acme: promptLogin() });
    const sessions = manager(registry, () => clock);
    const sessionId = crypto.randomUUID();
    await sessions.start({ provider: 'acme', sessionId });
    const signal = registry.controllers[0]!.signal!;

    clock += 10 * 60_000;
    await sessions.poll(sessionId, 0);
    clock += 10 * 60_000;
    sessions.sweep();
    expect((await sessions.poll(sessionId, 0)).status).toBe('awaiting-input');
    expect(signal.aborted).toBe(false);

    clock += 15 * 60_000 + 1;
    sessions.sweep();
    expect(signal.aborted).toBe(true);
    expect(sessions.size).toBe(0);
    await expect(sessions.poll(sessionId, 0)).rejects.toThrow('not_found');
    expect(() => sessions.input(sessionId, 'synthetic-late-token')).toThrow('not_found');
  });

  test('at most 20 sessions run at once; finished sessions give up their slot', async () => {
    const sessions = manager(fakeRegistry({ acme: promptLogin() }));
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
    for (const sessionId of ids) await sessions.start({ provider: 'acme', sessionId });
    await expect(sessions.start({ provider: 'acme', sessionId: crypto.randomUUID() })).rejects.toThrow('too_many_sessions');

    sessions.cancel(ids[3]!);
    await sessions.start({ provider: 'acme', sessionId: crypto.randomUUID() });
    expect(sessions.size).toBe(20);
    await expect(sessions.poll(ids[3]!, 0)).rejects.toThrow('not_found');
    sessions.close();
  });

  test('duplicate, malformed, and unknown starts are rejected', async () => {
    const sessions = manager(fakeRegistry({ acme: promptLogin() }));
    const sessionId = crypto.randomUUID();
    await sessions.start({ provider: 'acme', sessionId });
    await expect(sessions.start({ provider: 'acme', sessionId })).rejects.toThrow('session_exists');
    await expect(sessions.start({ provider: 'acme', sessionId: 'not-a-uuid' })).rejects.toThrow('invalid_request');
    await expect(sessions.start({ provider: 'unknown-provider', sessionId: crypto.randomUUID() })).rejects.toThrow('unknown_provider');
    sessions.close();
  });
});

describe('failure classification', () => {
  test('failures map to fixed classifications', () => {
    expect(classifyLoginError(new AIError.OAuthError('expired', { kind: 'timeout' }))).toBe('timeout');
    expect(classifyLoginError(new AIError.OAuthError('denied', { kind: 'device-auth' }))).toBe('provider_rejected');
    expect(classifyLoginError(new AIError.ProviderHttpError('unauthorized', 401))).toBe('provider_rejected');
    expect(classifyLoginError(new AIError.LoginCancelledError())).toBe('timeout');
    expect(classifyLoginError(new AIError.ConfigurationError('port in use'))).toBe('unsupported_flow');
    expect(classifyLoginError(new AIError.OnPromptRequiredError('Fake'))).toBe('unsupported_flow');
    expect(classifyLoginError(new Error('invalid_api_key'))).toBe('invalid_input');
    expect(classifyLoginError(new Error('unsupported_auth_method'))).toBe('unsupported_flow');
    expect(classifyLoginError(new Error('anything else'))).toBe('login_failed');
  });
});

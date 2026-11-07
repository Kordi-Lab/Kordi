import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudAuthClient, CloudAuthError } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { publishModelSubsession } from '../src/features/cloud/agentSubsessionSync';
import type { CloudAgentSubsession } from '../src/features/cloud/agentSubsessionTypes';

// A background session's turn holds a 30 s native deadline that this loop
// renews. One failed read or publish used to end the loop, so the healthy
// task was stopped 30 s later ("Stopped" after the owner's next message).
test('a failed read or publish does not stop a running background session', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldGet = CloudAuthClient.prototype.getAgentSubsession;
  const oldPut = CloudAuthClient.prototype.putAgentSubsession;
  const commands: string[] = [];
  let snapshots = 0;
  let writes = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: (callback: () => void) => setTimeout(callback, 1),
    __TAURI_INTERNALS__: { invoke: async (command: string) => {
      commands.push(command);
      if (command === 'desktop_chat_subsession_snapshot') {
        snapshots += 1;
        if (snapshots === 2) throw Error('database is locked');
        return { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'request', turnId: 'turn',
          title: 'Investigate', status: snapshots >= 6 ? 'done' : 'running', messages: [] };
      }
      if (command === 'desktop_chat_renew_execution_lease') return null;
      throw Error(`Unexpected command: ${command}`);
    } },
  } });
  __setSessionBackendForTests({ load: async () => ({ token: 'synthetic', accountId: 'owner', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
  CloudAuthClient.prototype.getAgentSubsession = async () => ({ status: 'running', version: writes }) as CloudAgentSubsession;
  CloudAuthClient.prototype.putAgentSubsession = async (_token, value) => {
    writes += 1;
    // An access token that expired between two publishes.
    if (writes === 2) throw new CloudAuthError('unauthorized', 'Sign in again', 401);
    return { status: value.status, version: writes } as CloudAgentSubsession;
  };
  try {
    await publishModelSubsession('child');
    for (let wait = 0; wait < 200 && snapshots < 6; wait += 1) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(snapshots, 6, 'the loop kept publishing until the task finished');
    assert(!commands.includes('desktop_chat_cancel_turn'), 'a failed attempt must not stop the task');
    assert(commands.filter(command => command === 'desktop_chat_renew_execution_lease').length >= 2);
  } finally {
    CloudAuthClient.prototype.getAgentSubsession = oldGet;
    CloudAuthClient.prototype.putAgentSubsession = oldPut;
    __setSessionBackendForTests(null);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

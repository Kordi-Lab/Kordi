import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudAuthClient, CloudAuthError } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { publishModelSubsession } from '../src/features/cloud/agentSubsessionSync';
import type { CloudAgentSubsession } from '../src/features/cloud/agentSubsessionTypes';

for (const conflict of [false, true]) {
  test(`a remote Stop cancels the real desktop turn${conflict ? ' after a publication conflict' : ''}`, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const oldGet = CloudAuthClient.prototype.getAgentSubsession;
    const oldPut = CloudAuthClient.prototype.putAgentSubsession;
    const commands: string[] = [];
    let reads = 0, writes = 0;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      setTimeout: (callback: () => void) => setTimeout(callback, 1),
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>) => {
        commands.push(command);
        if (command === 'desktop_chat_subsession_snapshot') return { sessionId: 'child', parentSessionId: 'parent', parentRequestId: 'request', turnId: 'actual-turn', title: 'Review', status: 'running', messages: [] };
        if (command === 'desktop_chat_cancel_turn') { assert.equal(args.turnId, 'actual-turn'); return {}; }
        throw Error(`Unexpected command: ${command}`);
      } },
    } });
    __setSessionBackendForTests({ load: async () => ({ token: 'synthetic', accountId: 'owner', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
    CloudAuthClient.prototype.getAgentSubsession = async () => ({ status: conflict && ++reads === 1 ? 'running' : 'stopped', version: 2 }) as CloudAgentSubsession;
    CloudAuthClient.prototype.putAgentSubsession = async () => { writes++; throw new CloudAuthError('subsession_is_terminal', 'Stopped', 409); };
    try {
      await publishModelSubsession('child');
      assert.equal(writes, conflict ? 1 : 0);
      assert.equal(commands.filter(command => command === 'desktop_chat_cancel_turn').length, 1);
      assert(!commands.includes('desktop_chat_renew_execution_lease'), 'a stopped task must not retain its execution lease');
    } finally {
      CloudAuthClient.prototype.getAgentSubsession = oldGet;
      CloudAuthClient.prototype.putAgentSubsession = oldPut;
      __setSessionBackendForTests(null);
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}

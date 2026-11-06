import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatSyncMessageDelivery } from '@/features/cloud/chatSyncMessageDelivery';
import { ChatSyncState, type ChatSyncRequest } from '@/features/cloud/chatSyncState';
import { browserSessionMarker } from '@web/auth/browserAppRuntime';
import { __setSessionBackendForTests, saveSession } from '@/features/cloud/session';
import { runBrowserChatSyncCommand } from '@web/runtime/browserChatSync';
import type { ChatSyncPendingOperation } from '@/lib/desktopChatSync';
import { conversation, message } from '../../../desktop/tests/helpers/chatSyncCanonicalFixtures';

const accountId = 'acct_b';
const token = browserSessionMarker(accountId);
const operation: ChatSyncPendingOperation = { accountId, operationId: 'op-1', attemptCount: 0,
  nextAttemptAtMs: 0, lastError: null, payload: { peerAccountId: 'acct_a', body: 'Original workspace', options: {} } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function session(organizationId: string) {
  await saveSession({ accountId, token, organizationId });
}
function backend() {
  __setSessionBackendForTests({ load: async () => null, save: async () => {}, clear: async () => {} });
}
function harness(send: ChatSyncRequest) {
  const calls: { name: string; organizationId: string | null | undefined }[] = [];
  const state = new ChatSyncState(send, () => accountId, () => {}, () => null);
  state.ensureConversation = async () => conversation;
  const outbox = {
    enqueue: async (_account: string, _operation: string, _payload: unknown, organizationId?: string | null) => { calls.push({ name: 'enqueue', organizationId }); },
    due: async (_account: string, organizationId?: string | null) => { calls.push({ name: 'due', organizationId }); return [operation]; },
    complete: async (_account: string, _operation: string, organizationId?: string | null) => { calls.push({ name: 'complete', organizationId }); },
    fail: async (_account: string, _operation: string, _error: string, _retryable: boolean, organizationId?: string | null) => { calls.push({ name: 'fail', organizationId }); },
  };
  return { state, outbox, calls, delivery: new ChatSyncMessageDelivery(state, outbox) };
}

test('pending outbox rows loaded before an organization switch never start delivery in the new organization', async () => {
  backend();
  try {
    await session('org-first');
    const pending = deferred<ChatSyncPendingOperation[]>();
    let requests = 0;
    const fixture = harness(async () => { requests += 1; throw new Error('Unexpected send'); });
    fixture.outbox.due = async () => pending.promise;
    const drain = fixture.delivery.drainChatOutbox(token, accountId);
    await session('org-second');
    pending.resolve([operation]);
    await assert.rejects(drain, /organization changed/);
    assert.equal(requests, 0);
    assert.deepEqual(fixture.calls, []);
  } finally { __setSessionBackendForTests(null); }
});

test('switching organizations while resolving a conversation stops the subsequent message POST', async () => {
  backend();
  try {
    await session('org-first');
    const resolving = deferred<typeof conversation>();
    const started = deferred<void>();
    let requests = 0;
    const fixture = harness(async () => { requests += 1; throw new Error('Unexpected send'); });
    fixture.state.ensureConversation = () => { started.resolve(); return resolving.promise; };
    const send = fixture.delivery.sendMessage(token, 'acct_a', 'Original workspace', { accountId });
    await started.promise;
    await session('org-second');
    resolving.resolve(conversation);
    await assert.rejects(send, /organization changed/);
    assert.equal(requests, 0);
    assert.deepEqual(fixture.calls, [{ name: 'enqueue', organizationId: 'org-first' }]);
  } finally { __setSessionBackendForTests(null); }
});

test('a delayed accepted response cannot complete an outbox row or publish messages in another organization', async () => {
  backend();
  try {
    await session('org-first');
    const response = deferred<{ message: typeof message }>();
    const started = deferred<void>();
    const fixture = harness(async <T>(_path: string, init: RequestInit): Promise<T> => {
      assert.equal(new Headers(init.headers).get('Kordi-Organization'), 'org-first');
      started.resolve(); return response.promise as Promise<T>;
    });
    const send = fixture.delivery.sendMessage(token, 'acct_a', 'Original workspace', { accountId });
    await started.promise;
    await session('org-second');
    response.resolve({ message });
    await assert.rejects(send, /organization changed/);
    assert.equal(fixture.state.messageById.size, 0);
    assert.deepEqual(fixture.calls, [{ name: 'enqueue', organizationId: 'org-first' }]);
  } finally { __setSessionBackendForTests(null); }
});

test('unchanged workspace sends and completes in its original organization', async () => {
  backend();
  try {
    await session('org-first');
    const fixture = harness(async <T>() => ({ message }) as T);
    await fixture.delivery.sendMessage(token, 'acct_a', 'Original workspace', { accountId });
    assert.deepEqual(fixture.calls, [
      { name: 'enqueue', organizationId: 'org-first' }, { name: 'complete', organizationId: 'org-first' },
    ]);
  } finally { __setSessionBackendForTests(null); }
});

test('browser outbox persistence rejects missing or changed organization before opening storage', async () => {
  for (const command of ['enqueue', 'due', 'complete', 'fail']) {
    for (const expectedOrganizationId of [undefined, null, 'org-first']) {
      const scope = { accountId, expectedOrganizationId };
      const args = command === 'enqueue' || command === 'fail' ? { request: scope } : scope;
      await assert.rejects(runBrowserChatSyncCommand(accountId, 'org-second', `desktop_chat_sync_outbox_${command}`, args), /organization changed/);
    }
  }
});

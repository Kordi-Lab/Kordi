import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { ConversationSendQueue } from '../src/features/chat/messageActions/conversationSendQueue';
import type { CloudAccount, CloudAuthClient, CloudMessage } from '../src/features/cloud/authClient';
import { CloudGroupOutbox } from '../src/features/cloud/cloudGroupOutbox';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudGroupControlSender } from '../src/features/cloud/useCloudGroupControlSender';
import type { CloudGroupControlTransport } from '../src/features/cloud/useCloudGroupControlSender.types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function fixture(context: TestContext, durable = true) {
  const account: CloudAccount = {
    accountId: 'acct_me', displayName: 'Me', primaryEmail: 'me@example.com',
    avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
  };
  __setSessionBackendForTests({
    load: async () => ({ accountId: account.accountId, token: 'synthetic-token', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => {}, clear: async () => {},
  });
  context.after(() => __setSessionBackendForTests(null));
  const events: string[] = [];
  const warnings: string[] = [];
  const outbox = durable ? new CloudGroupOutbox(account.accountId, {
    load: async () => null, save: async () => {},
  }) : null;
  const transport: CloudGroupControlTransport = {
    client: { sendMessage: async (_token: string, peer: string, body: string) => {
      const id = parseCloudGroupControl(body)?.message?.id ?? 'control';
      events.push(`post:${id}`);
      return { messageId: id, fromAccountId: account.accountId, toAccountId: peer,
        body, createdAt: new Date().toISOString(), deliveredAt: null, readAt: null,
        direction: 'outgoing' } satisfies CloudMessage;
    } } as CloudAuthClient,
    messageIndex: buildCloudMessageIndex(account.accountId, {}), outbox,
    mergeMessage: (message) => { events.push(`merge:${message.messageId}`); },
    persistOutboxDelivery: async (entry) => {
      events.push(`persist:${entry.canonicalMessageId}`);
      await outbox?.acknowledgeCanonicalDelivery(entry.canonicalMessageId);
    },
    claimFreshFallback: async () => { events.push('fallback'); },
    syncDiff: async () => { events.push('sync'); },
  };
  let send!: ReturnType<typeof useCloudGroupControlSender>;
  function Harness() {
    send = useCloudGroupControlSender({ account, transport, canonical: { stateRef: { current: null } },
      reportWarning: (message) => { warnings.push(message); } });
    return null;
  }
  const input = (id: string) => ({
    kind: 'group-message' as const, groupId: 'session:group:latency', targetAccountIds: ['acct_peer'],
    participants: [account, { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null }],
    message: { id, senderAccountId: account.accountId, text: id, createdAtMs: Date.now() },
  });
  return { events, warnings, transport, send: (id: string) => {
    renderToString(createElement(Harness));
    return send(input(id));
  } };
}

for (const durable of [true, false]) {
  test(`acknowledged group sends release the next message before background work (${durable ? 'durable' : 'fallback'})`, async (context) => {
    const f = fixture(context, durable);
    const background = gate();
    context.after(background.release);
    f.transport.claimFreshFallback = async () => { f.events.push('fallback'); await background.promise; };
    f.transport.syncDiff = async () => { f.events.push('sync'); await background.promise; };
    const queue = new ConversationSendQueue();
    let completed = false;
    const first = queue.run('chat', () => f.send('first'));
    const second = queue.run('chat', () => f.send('second'));
    void Promise.all([first, second]).then(() => { completed = true; });
    await turn();
    assert.equal(completed, true, 'background sync/fallback must not extend the send lane');
    assert.deepEqual(f.events.filter((event) => event.startsWith('post:')), ['post:first', 'post:second']);
    assert.equal(f.events.filter((event) => event === 'fallback').length, 2);
    assert.equal(f.events.filter((event) => event === 'sync').length, 2);
    if (durable) assert.ok(f.events.indexOf('persist:first') < f.events.indexOf('post:second'));
    background.release();
    await Promise.all([first, second]);
  });
}

test('delivery persistence still gates the next message', async (context) => {
  const f = fixture(context);
  const persistence = gate();
  context.after(persistence.release);
  f.transport.persistOutboxDelivery = async () => { await persistence.promise; };
  let completed = false;
  const send = f.send('first').then(() => { completed = true; });
  await turn();
  assert.equal(completed, false);
  persistence.release();
  await send;
});

test('post-send failures are reported without rejecting an accepted message', async (context) => {
  const f = fixture(context);
  f.transport.claimFreshFallback = async () => { throw new Error('synthetic fallback failure'); };
  f.transport.syncDiff = async () => { throw new Error('synthetic sync failure'); };
  await f.send('first');
  await turn();
  assert.deepEqual(f.warnings.sort(), ['[cloud-group] fallback claim failed', '[cloud-group] post-send sync failed']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { cloudGroupSendPlan } from '../src/features/chat/messageActions/cloudGroupSendPlan';
import { CloudAuthClient, type CloudAccount } from '../src/features/cloud/authClient';
import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { useCloudGroupControlSender } from '../src/features/cloud/useCloudGroupControlSender';
import { installDom } from './helpers/transcriptAttachmentDom';

const GROUP = 'session:group:owner-only';

test('an owner-only Cloud group stays sendable; non-Cloud groups without targets do not', () => {
  assert.deepEqual(cloudGroupSendPlan([], GROUP), { cloudGroupTargetIds: [], cloudGroupSendable: true });
  assert.deepEqual(cloudGroupSendPlan([], 'local-session'), { cloudGroupTargetIds: [], cloudGroupSendable: false });
  assert.deepEqual(cloudGroupSendPlan([], null), { cloudGroupTargetIds: [], cloudGroupSendable: false });
  assert.deepEqual(
    cloudGroupSendPlan([{ hostId: 'cloud', nodeId: 'acct_peer' }], GROUP),
    { cloudGroupTargetIds: ['acct_peer'], cloudGroupSendable: true },
  );
  // Non-Cloud recipients keep their own path instead of the owner-only one.
  assert.equal(cloudGroupSendPlan([{ hostId: 'bridge-host', nodeId: 'node-1' }], GROUP).cloudGroupSendable, false);
});

test('a group message with no other member is posted once, addressed to the owner', async () => {
  const { restore } = installDom();
  const root = createRoot(document.createElement('div'));
  const sent: Array<{ peer: string; body: string; options: Record<string, unknown> }> = [];
  let send!: ReturnType<typeof useCloudGroupControlSender>;
  __setSessionBackendForTests({
    load: async () => ({ token: 'synthetic', accountId: 'acct_self', expiresAt: '2099-01-01' }),
    save: async () => {}, clear: async () => {},
  });
  function Harness() {
    send = useCloudGroupControlSender({
      account: { accountId: 'acct_self', displayName: 'Self', avatar: {} } as CloudAccount,
      canonical: { stateRef: { current: null } },
      transport: {
        client: { sendMessage: async (_token: string, peer: string, body: string, options: Record<string, unknown>) => {
          sent.push({ peer, body, options });
          return { messageId: `wire-${sent.length}`, body };
        } } as unknown as CloudAuthClient,
        messageIndex: buildCloudMessageIndex('acct_self', {}), outbox: null,
        mergeMessage() {}, persistOutboxDelivery: async () => {},
        claimFreshFallback: async () => {}, syncDiff: async () => {},
      },
      reportWarning() {},
    });
    return null;
  }
  try {
    await act(async () => root.render(<Harness />));
    await send({
      kind: 'group-message', groupId: GROUP, groupSpaceId: GROUP, targetAccountIds: [],
      collaborationParticipants: [],
      message: { id: 'first', senderAccountId: '', text: 'Hello Kordi', createdAtMs: 1 },
    });
    // Before the fix the sender returned without sending anything.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].peer, 'acct_self');
    assert.equal(sent[0].options.sessionId, GROUP);
    assert.equal(sent[0].options.conversationKind, 'group');
    const envelope = parseCloudGroupControl(sent[0].body);
    assert.equal(envelope?.message?.text, 'Hello Kordi');
    assert.deepEqual(envelope?.participants.map((participant) => participant.accountId), ['acct_self']);
  } finally {
    await act(async () => root.unmount());
    __setSessionBackendForTests(null);
    restore();
  }
});

test('the owner-addressed send lands in the existing group conversation without changing members', async () => {
  const member = { account_id: 'acct_self', role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 0, last_read_sequence: 0, joined_at: '2026-10-20T00:00:00Z', left_at: null };
  const conversation = {
    id: '019cb111-8ecc-7181-8266-8986d950169c', kind: 'group', shared_title: 'Personal agent memory', version: 1,
    created_by_account_id: 'acct_self', legacy_session_id: GROUP, latest_message_sequence: 0,
    created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', members: [member],
    preferences: { conversation_id: '019cb111-8ecc-7181-8266-8986d950169c', account_id: 'acct_self', personal_title: null, version: 1 },
  };
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const payload = url.endsWith('/v2/chat/conversations')
      ? { conversation }
      : { message: {
          id: crypto.randomUUID(), client_message_id: body.client_message_id, conversation_id: conversation.id,
          conversation_sequence: 1, sender_account_id: 'acct_self', kind: 'text', content: body.content,
          reply_to_message_id: null, attachment_ids: [], version: 1,
          created_at: '2026-10-20T00:00:01Z', edited_at: null, deleted_at: null,
        } };
    return new Response(JSON.stringify(payload), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const client = new CloudAuthClient({ baseUrl: 'http://srv', fetchImpl });
  const envelope = 'kordi-cloud-group:' + Buffer.from(JSON.stringify({
    kind: 'group-message', groupId: GROUP, participants: [{ accountId: 'acct_self', displayName: 'Self' }],
  })).toString('base64url');
  const message = await client.sendMessage('token', 'acct_self', envelope, {
    sessionId: GROUP, conversationKind: 'group', memberAccountIds: ['acct_self'], clientMessageId: 'first',
  });
  const open = calls.find((call) => call.url.endsWith('/v2/chat/conversations'));
  // The server resolves the existing group by session id when members match.
  assert.equal(open?.body.client_session_id, GROUP);
  assert.deepEqual(open?.body.member_account_ids, ['acct_self']);
  assert.equal(calls.some((call) => call.url.endsWith('/members')), false);
  const post = calls.filter((call) => call.url.endsWith(`/v2/chat/conversations/${conversation.id}/messages`));
  assert.equal(post.length, 1);
  assert.equal(post[0].method, 'POST');
  assert.equal(message.sessionId, GROUP);
});

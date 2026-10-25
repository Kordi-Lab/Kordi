import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, createElement } from 'react';

import { cloudMessageFromChatSync, type ChatSyncConversation, type ChatSyncMessage } from '../src/features/cloud/authClient';
import { cloudMessageMetadataOnly } from '../src/features/cloud/cloudMessageCache';
import { normalizeProactiveOffer, type MessageProactiveOffer } from '../src/features/cloud/proactiveOffer';
import { ProactiveOfferCard } from '../src/kordi-app/components/proactiveOfferCard';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { Message } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const NOW = Date.parse('2026-10-24T10:00:00Z');
const block = {
  type: 'proactive_offer', proposalId: 'pro_1', agentId: 'agent_1', agentName: 'Scout', conversationId: 'conv_g',
  sessionId: 'session:group:g1', conversationTitle: 'Launch crew', triggerMessageId: 'msg_t', problem: 'Priya is stuck on the CI cache.',
  offer: 'I can clear the cache key and rerun the job.', plan: 'Find the failing step\nBump the key\nRerun', status: 'pending',
  expiresAt: '2026-10-24T15:30:00Z', runId: null, decidedAt: null,
};
const fallback = 'Scout can help in Launch crew: Priya is stuck on the CI cache.';

const conversation: ChatSyncConversation = {
  id: 'conv_dm', kind: 'direct', shared_title: null, version: 1, created_by_account_id: 'acct_owner',
  legacy_session_id: 'session:direct:acct_owner:agent_1', latest_message_sequence: 1,
  created_at: '2026-10-24T09:00:00Z', updated_at: '2026-10-24T09:59:00Z',
  members: [
    { account_id: 'acct_owner', display_name: 'Alex', avatar_url: null, role: 'owner', membership_state: 'active', version: 1, last_delivered_sequence: 1, last_read_sequence: 1, joined_at: '2026-10-24T09:00:00Z', left_at: null },
  ],
  preferences: { conversation_id: 'conv_dm', account_id: 'acct_owner', personal_title: null, version: 1 },
};
const message: ChatSyncMessage = {
  id: 'msg_card', client_message_id: 'client_card', conversation_id: 'conv_dm', conversation_sequence: 1,
  sender_account_id: 'agent_1', kind: 'text', content: { schema: 1, blocks: [{ type: 'text', text: fallback }, block] },
  reply_to_message_id: null, attachment_ids: [], version: 1, generation_status: null, provider_response_id: null,
  created_at: '2026-10-24T09:59:00Z', edited_at: null, deleted_at: null,
};

const offer = normalizeProactiveOffer(block)!;

test('chat sync parses a proactive_offer block and keeps it through the cache', () => {
  const mapped = cloudMessageFromChatSync(message, conversation, 'acct_owner');
  assert.deepEqual(mapped.proactiveOffer, offer);
  assert.equal(mapped.proactiveOffer?.problem, 'Priya is stuck on the CI cache.');
  assert.deepEqual(cloudMessageMetadataOnly(mapped).proactiveOffer, offer);
  const plain = cloudMessageFromChatSync({ ...message, content: { schema: 1, blocks: [{ type: 'text', text: fallback }] } }, conversation, 'acct_owner');
  assert.equal(plain.proactiveOffer, null);
});

test('malformed proactive blocks do not crash and fall back to defaults', () => {
  assert.equal(normalizeProactiveOffer({ type: 'proactive_offer', agentId: 'a' }), null);
  assert.equal(normalizeProactiveOffer('nope'), null);
  const sparse = normalizeProactiveOffer({ type: 'proactive_offer', proposalId: 'p', agentId: 'a', status: 'weird', plan: 7 });
  assert.equal(sparse?.status, 'pending');
  assert.equal(sparse?.plan, '');
  assert.equal(sparse?.agentName, 'Your agent');
});

test('the transcript renders the card instead of the text fallback', async () => {
  const msg: Message = { role: 'person', sender: 'Scout', senderType: 'agent', isOwnMessage: false, text: fallback, time: '09:59', proactiveOffer: offer };
  await withJsdomRoot(async (mount) => {
    const host = await mount(createElement(MessageBubble, { msg }));
    assert.ok(host.querySelector('.app-proactive-offer'));
    assert.equal(host.textContent?.includes(fallback), false);
    assert.match(host.textContent ?? '', /Scout can help in Launch crew/);
  });
});

async function renderCard(card: MessageProactiveOffer, extra: Partial<Parameters<typeof ProactiveOfferCard>[0]> = {}) {
  let text = '';
  let status = '';
  await withJsdomRoot(async (mount) => {
    const host = await mount(<ProactiveOfferCard offer={card} now={NOW} {...extra} />);
    text = host.textContent ?? '';
    status = host.querySelector('.app-proactive-offer')?.getAttribute('data-proactive-offer-status') ?? '';
  });
  return { text, status };
}

test('a pending card shows the offer, the plan, the actions and the time left', async () => {
  const { text } = await renderCard(offer);
  assert.match(text, /Scout can help in Launch crew/);
  assert.match(text, /Priya is stuck on the CI cache\./);
  assert.match(text, /I can clear the cache key and rerun the job\./);
  assert.match(text, /Bump the key/);
  assert.match(text, /Expires in 6h/);
  assert.match(text, /Not now/);
  assert.match(text, /Allow/);
});

test('each status renders its own state line', async () => {
  const cases: Array<[MessageProactiveOffer['status'], RegExp]> = [
    ['approved', /Working in Launch crew…/],
    ['running', /Working in Launch crew…/],
    ['done', /Replied in Launch crewOpen/],
    ['declined', /Not now/],
    ['expired', /Expired/],
    ['failed', /Could not finish/],
  ];
  for (const [status, expected] of cases) {
    const { text } = await renderCard({ ...offer, status });
    assert.match(text, expected, status);
    assert.equal(/Allow/.test(text), false, status);
  }
  const lapsed = await renderCard({ ...offer, expiresAt: '2026-10-24T09:00:00Z' });
  assert.equal(lapsed.status, 'expired');
});

test('Open on a done card opens the group conversation', async () => {
  const opened: string[] = [];
  await withJsdomRoot(async (mount) => {
    const host = await mount(<ProactiveOfferCard offer={{ ...offer, status: 'done' }} now={NOW} openSession={(id) => opened.push(id)} />);
    const open = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Open');
    await act(async () => { open!.click(); });
  });
  assert.deepEqual(opened, ['session:group:g1']);
});

test('Allow and Not now call the client and update the card from the returned proposal', async () => {
  for (const [label, decision, returned, expected] of [
    ['Allow', 'allow', { proposal: { proposalId: 'pro_1', status: 'running', runId: 'proactive_run_pro_1' } }, /Working in Launch crew…/],
    ['Not now', 'decline', { proposalId: 'pro_1', status: 'declined' }, /RerunNot now$/],
  ] as const) {
    const calls: Array<[string, string, string]> = [];
    await withJsdomRoot(async (mount) => {
      const host = await mount(<ProactiveOfferCard offer={offer} now={NOW} decide={async (card, choice) => { calls.push([card.agentId, card.proposalId, choice]); return returned; }} />);
      const button = Array.from(host.querySelectorAll('button')).find((element) => element.textContent === label);
      await act(async () => { button!.click(); });
      assert.match(host.textContent ?? '', expected);
    });
    assert.deepEqual(calls, [['agent_1', 'pro_1', decision]]);
  }
});

test('a closed offer shows the conflict message inline and keeps the actions', async () => {
  await withJsdomRoot(async (mount) => {
    const host = await mount(<ProactiveOfferCard offer={offer} now={NOW} decide={async () => { throw new Error('This offer is no longer open.'); }} />);
    const allow = Array.from(host.querySelectorAll('button')).find((element) => element.textContent === 'Allow');
    await act(async () => { allow!.click(); });
    assert.equal(host.querySelector('[role="alert"]')?.textContent, 'This offer is no longer open.');
    assert.ok(Array.from(host.querySelectorAll('button')).some((element) => element.textContent === 'Allow'));
  });
});

test('decideProactiveProposal posts the decision and maps 409 to a clear message', async () => {
  const { decideProactiveProposal, listProactiveActivity } = await import('../src/features/cloud/proactiveClient');
  const previous = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/activity')) return new Response(JSON.stringify({ activity: [{ at: '2026-10-24T09:00:00Z', conversationTitle: 'Launch crew', decision: 'silence' }] }), { status: 200 });
    if (calls.length === 1) return new Response(JSON.stringify({ proposal: { status: 'approved' } }), { status: 200 });
    return new Response(JSON.stringify({ errorCode: 'conflict', message: 'not pending' }), { status: 409 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await decideProactiveProposal('tok', 'agent_1', 'pro_1', 'allow'), { proposal: { status: 'approved' } });
    assert.match(calls[0]!.url, /\/v1\/cloud\/agents\/agent_1\/proactive\/proposals\/pro_1\/decision$/);
    assert.equal(calls[0]!.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { decision: 'allow' });
    await assert.rejects(decideProactiveProposal('tok', 'agent_1', 'pro_1', 'decline'), { message: 'This offer is no longer open.', status: 409 });
    const activity = await listProactiveActivity('tok', 'agent_1', 50);
    assert.match(calls[2]!.url, /\/v1\/cloud\/agents\/agent_1\/proactive\/activity\?limit=50$/);
    assert.equal(activity[0]?.decision, 'silence');
  } finally {
    globalThis.fetch = previous;
  }
});

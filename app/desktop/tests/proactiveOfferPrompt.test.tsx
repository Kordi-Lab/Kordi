import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { ACCOUNT_HINT_EVENT_TYPES } from '../src/features/cloud/accountHintEvents';
import { listPendingProactiveProposals } from '../src/features/cloud/proactiveClient';
import { normalizeProactiveProposal, proactiveProposalWithUpdate } from '../src/features/cloud/proactiveOffer';
import { __setSessionBackendForTests, type StoredSession } from '../src/features/cloud/session';
import { ProactiveOfferPrompt } from '../src/features/proactive/ProactiveOfferPrompt';
import { proactiveConversationKey } from '../src/features/proactive/useProactiveProposals';
import { notifyProactiveProposalEvents } from '../src/features/proactive/proactiveProposalEvents';
import type { Conversation } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const NOW = Date.parse('2026-10-24T10:00:00Z');
const OWNER = 'acct_owner';
const DEFAULT_ID = `cloud-agent:${OWNER}`;
const ENCODED = 'cloud-agent%3Aacct_owner';
const GROUP_SESSION = 'session:group:g1';
const proposal = {
  proposalId: 'pro_1', agentId: DEFAULT_ID, agentName: 'Kordi', conversationId: 'conv_g', sessionId: GROUP_SESSION,
  conversationTitle: 'Launch crew', triggerMessageId: 'msg_t', problem: 'Priya is stuck on the CI cache.',
  offer: 'I can clear the cache key and rerun the job.', plan: 'Find the failing step\nBump the key\nRerun', status: 'pending',
  expiresAt: '2026-10-24T15:30:00Z', runId: null, decidedAt: null, createdAt: '2026-10-24T09:59:00Z',
};
type PromptConversation = Pick<Conversation, 'id' | 'canonicalSessionId' | 'messages' | 'participantSpaceId' | 'directness'>;
const CONV_UUID = '7f3c2a10-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
const group: PromptConversation = { id: GROUP_SESSION, canonicalSessionId: GROUP_SESSION, messages: [] };
const other: PromptConversation = { id: 'session:group:g2', canonicalSessionId: 'session:group:g2', messages: [] };
const withConversationId = (conversationId: string): PromptConversation => ({
  ...group,
  messages: [{ role: 'person', sender: 'Priya', text: 'hi', time: '09:59', reactionConversationId: conversationId }],
});

function setSession(session: StoredSession | null) {
  __setSessionBackendForTests({ load: async () => session, save: async () => undefined, clear: async () => undefined });
}

type Call = { url: string; method: string; body: unknown };
function stubFetch(list: () => unknown[]) {
  const calls: Call[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) as unknown : undefined });
    if (String(url).includes('/decision')) return new Response(JSON.stringify({ proposalId: 'pro_1', status: 'running', runId: 'run_1' }), { status: 200 });
    return new Response(JSON.stringify({ proposals: list() }), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function hint(payload: Record<string, unknown>) {
  await act(async () => { notifyProactiveProposalEvents([{ eventType: 'proactive.proposal_changed', payload }]); });
  await flush();
}

async function withPrompt(
  setup: { session: StoredSession | null; list: () => unknown[]; conversation?: typeof group; accountId?: string | null },
  run: (host: HTMLElement, calls: Call[]) => Promise<void>,
) {
  setSession(setup.session);
  const server = stubFetch(setup.list);
  try {
    await withJsdomRoot(async (mount) => {
      const host = await mount(<ProactiveOfferPrompt conversation={setup.conversation ?? group} accountId={setup.accountId === undefined ? OWNER : setup.accountId} now={NOW} />);
      await flush();
      await run(host, server.calls);
    });
  } finally {
    server.restore();
    __setSessionBackendForTests(null);
  }
}

const signedIn: StoredSession = { token: 'tok', accountId: OWNER, expiresAt: '2099-01-01T00:00:00Z' };
const button = (host: HTMLElement, label: string) => Array.from(host.querySelectorAll('button')).find((element) => element.textContent === label);

test('the pending list route asks for pending proposals of one conversation', async () => {
  const server = stubFetch(() => [proposal, { proposalId: '', agentId: 'x' }]);
  try {
    const list = await listPendingProactiveProposals('tok', 'conv_g');
    assert.equal(list.length, 1);
    assert.equal(list[0]!.agentName, 'Kordi');
    assert.match(server.calls[0]!.url, /\/v1\/cloud\/proactive\/proposals\?status=pending&conversationId=conv_g$/);
    await listPendingProactiveProposals('tok');
    assert.match(server.calls[1]!.url, /\/v1\/cloud\/proactive\/proposals\?status=pending$/);
  } finally {
    server.restore();
  }
});

test('a hint update keeps the fields it leaves out', () => {
  const base = normalizeProactiveProposal(proposal)!;
  const next = proactiveProposalWithUpdate(base, { status: 'done', replyMessageId: 'msg_r' });
  assert.equal(next.status, 'done');
  assert.equal(next.replyMessageId, 'msg_r');
  assert.equal(next.agentName, 'Kordi');
  assert.equal(next.problem, base.problem);
});

test('the conversation key carries the session ids and the cloud conversation id', () => {
  const key = proactiveConversationKey({ id: GROUP_SESSION, canonicalSessionId: GROUP_SESSION, messages: [
    { role: 'person', sender: 'Priya', text: 'hi', time: '09:59', reactionConversationId: 'conv_g' },
  ] }, OWNER);
  assert.deepEqual(key, { accountId: OWNER, isGroup: true, sessionIds: [GROUP_SESSION], conversationId: 'conv_g' });
});

test('a UUID conversation key filters the list route by conversation', async () => {
  await withPrompt({ session: signedIn, list: () => [{ ...proposal, conversationId: CONV_UUID }], conversation: withConversationId(CONV_UUID) }, async (host, calls) => {
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, new RegExp(`\\?status=pending&conversationId=${CONV_UUID}$`));
    assert.match(host.textContent ?? '', /Kordi can help here/);
  });
});

test('a session-id fallback key asks for all pending offers and still filters by session', async () => {
  const stray = { ...proposal, proposalId: 'pro_x', sessionId: 'session:group:g9', conversationId: 'conv_x', problem: 'Elsewhere.' };
  await withPrompt({ session: signedIn, list: () => [proposal, stray], conversation: withConversationId(GROUP_SESSION) }, async (host, calls) => {
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\?status=pending$/);
    const text = host.textContent ?? '';
    assert.match(text, /Priya is stuck on the CI cache\./);
    assert.doesNotMatch(text, /Elsewhere\./);
  });
});

test('one-to-one agent and contact chats never ask for offers', async () => {
  const agentChat: PromptConversation = { id: 'session:agent:a1', canonicalSessionId: 'session:agent:a1', messages: [] };
  const contactChat: PromptConversation = { id: 'session:dm:c1', canonicalSessionId: 'session:dm:c1', messages: [], directness: 'Direct' };
  for (const conversation of [agentChat, contactChat]) {
    await withPrompt({ session: signedIn, list: () => [{ ...proposal, sessionId: conversation.id }], conversation }, async (host, calls) => {
      assert.equal(calls.length, 0);
      await hint({ proposalId: 'pro_9', agentId: DEFAULT_ID, conversationId: null, sessionId: conversation.id, status: 'pending' });
      assert.equal(calls.length, 0);
      assert.equal(host.querySelector('[data-proactive-offer-prompt]'), null);
    });
  }
});

test('the owner sees a matching pending offer above the composer', async () => {
  await withPrompt({ session: signedIn, list: () => [proposal] }, async (host) => {
    const text = host.textContent ?? '';
    assert.match(text, /Kordi can help here/);
    assert.match(text, /Priya is stuck on the CI cache\./);
    assert.match(text, /I can clear the cache key and rerun the job\./);
    assert.match(text, /Expires in 6h/);
    assert.ok(button(host, 'Not now'));
    assert.ok(button(host, 'Allow'));
  });
});

test('the offer is hidden in another conversation', async () => {
  await withPrompt({ session: signedIn, list: () => [proposal], conversation: other }, async (host) => {
    assert.equal(host.querySelector('[data-proactive-offer-prompt]'), null);
  });
});

test('the offer is hidden and nothing is fetched when signed out', async () => {
  await withPrompt({ session: null, list: () => [proposal] }, async (host, calls) => {
    assert.equal(host.querySelector('[data-proactive-offer-prompt]'), null);
    assert.equal(calls.length, 0);
  });
  await withPrompt({ session: signedIn, list: () => [proposal], accountId: null }, async (host, calls) => {
    assert.equal(host.querySelector('[data-proactive-offer-prompt]'), null);
    assert.equal(calls.length, 0);
  });
});

test('Allow posts to the encoded decision path, shows Working…, and a done hint hides it', async () => {
  await withPrompt({ session: signedIn, list: () => [proposal] }, async (host, calls) => {
    await act(async () => { button(host, 'Allow')!.click(); });
    await flush();
    const decision = calls.find((call) => call.method === 'POST')!;
    assert.match(decision.url, new RegExp(`/v1/cloud/agents/${ENCODED}/proactive/proposals/pro_1/decision$`));
    assert.deepEqual(decision.body, { decision: 'allow' });
    assert.match(host.textContent ?? '', /Working…/);
    assert.equal(button(host, 'Allow'), undefined);
    await hint({ proposalId: 'pro_1', agentId: DEFAULT_ID, conversationId: 'conv_g', sessionId: GROUP_SESSION, status: 'done', replyMessageId: 'msg_r' });
    assert.equal(host.querySelector('[data-proactive-offer-prompt]'), null);
  });
});

test('Not now hides the offer', async () => {
  await withPrompt({ session: signedIn, list: () => [proposal] }, async (host, calls) => {
    await act(async () => { button(host, 'Not now')!.click(); });
    await flush();
    assert.deepEqual(calls.find((call) => call.method === 'POST')!.body, { decision: 'decline' });
    assert.equal(host.querySelector('[data-proactive-offer-prompt]'), null);
  });
});

test('a new pending hint for the open conversation shows the offer', async () => {
  let served: unknown[] = [];
  await withPrompt({ session: signedIn, list: () => served }, async (host, calls) => {
    assert.equal(host.querySelector('[data-proactive-offer-prompt]'), null);
    await hint({ proposalId: 'pro_2', agentId: DEFAULT_ID, conversationId: 'conv_other', sessionId: 'session:group:g2', status: 'pending' });
    assert.equal(calls.length, 1);
    served = [proposal];
    await hint({ proposalId: 'pro_1', agentId: DEFAULT_ID, conversationId: 'conv_g', sessionId: GROUP_SESSION, status: 'pending' });
    assert.equal(calls.length, 2);
    assert.match(host.textContent ?? '', /Kordi can help here/);
  });
});

test('a failed hint shows briefly instead of the buttons, and an expired offer never shows', async () => {
  await withPrompt({ session: signedIn, list: () => [proposal] }, async (host) => {
    await hint({ proposalId: 'pro_1', agentId: DEFAULT_ID, conversationId: 'conv_g', sessionId: GROUP_SESSION, status: 'failed' });
    assert.match(host.textContent ?? '', /Could not finish/);
    assert.equal(button(host, 'Allow'), undefined);
  });
  await withPrompt({ session: signedIn, list: () => [{ ...proposal, expiresAt: '2026-10-24T09:00:00Z' }] }, async (host) => {
    assert.equal(host.querySelector('[data-proactive-offer-prompt]'), null);
  });
});

test('proactive.run_requested hints pass the account hint allowlist and leave the prompt alone', async () => {
  assert.ok(ACCOUNT_HINT_EVENT_TYPES.has('proactive.proposal_changed'));
  assert.ok(ACCOUNT_HINT_EVENT_TYPES.has('proactive.run_requested'));
  await withPrompt({ session: signedIn, list: () => [] }, async (_host, calls) => {
    await act(async () => { notifyProactiveProposalEvents([{ eventType: 'proactive.run_requested', payload: { proposalId: 'pro_1', agentId: DEFAULT_ID, sessionId: GROUP_SESSION, status: 'pending' } }]); });
    await flush();
    assert.equal(calls.length, 1);
  });
});

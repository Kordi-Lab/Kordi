import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AgentTrustApi, AgentTrustCalls } from '../src/features/agentTrust/agentTrustApi';
import {
  messageOffersReplyDisclosure,
  replyDisclosureRequestFor,
  replyDisclosureTargetForMessage,
  requestReplyDisclosure,
  type ReplyDisclosureTarget,
} from '../src/features/agentTrust/replyDisclosureTarget';
import { clearAiFeaturesCache } from '../src/features/agentTrust/useAiFeatures';
import { clearReplyDisclosureCache, loadReplyDisclosure } from '../src/features/agentTrust/useReplyDisclosures';
import type { ReplyDisclosure, ReplyDisclosureRequest } from '../src/features/cloud/agentTrustTypes';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { KORDI_PIP_AVATAR_URL } from '../src/features/pip/pipIdentity';
import { AgentAiChip } from '../src/kordi-app/components/AgentOwnerTag';
import { ThreadMessageHeader } from '../src/kordi-app/components/ThreadMessageHeader';
import { pipDisclosureText, replyDisclosureRows } from '../src/features/agentTrust/replyDisclosureCopy';
import { AgentReplyDisclosureHost } from '../src/kordi-app/components/agentReplyDisclosureDialog';
import type { Message } from '../src/kordi-app/types';
import { turn } from './helpers/replyAttributionFixtures';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

const cloud: ReplyDisclosure = {
  key: 'reply-1', agentId: 'cloud-agent:acct_o', agentName: 'Scout', ownerAccountId: 'acct_o', ownerName: 'Olivia',
  requesterAccountId: 'acct_r', requesterName: 'Rui', runtime: 'kordi_cloud', credentials: 'owner',
  provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5.5',
};

test('cloud replies show the agent, owner, requester, place, model, and model account', () => {
  assert.deepEqual(replyDisclosureRows(cloud), [
    'Agent: Scout', 'Runs for: Olivia', 'Requested by: Rui', 'Ran on: Kordi Cloud',
    'Model: gpt-5.5 (OpenAI)', 'Model account: Olivia\'s',
  ]);
  assert.ok(replyDisclosureRows({ ...cloud, model: null }).includes('Model: OpenAI'));
  assert.ok(replyDisclosureRows({ ...cloud, model: null, provider: null, providerLabel: null }).includes('Model: Not reported'));
  const support = replyDisclosureRows({ ...cloud, credentials: 'kordi' });
  assert.ok(support.includes('Runs for: Kordi'));
  assert.ok(support.includes('Model account: Kordi\'s'));
});

test('Mac replies never claim a model', () => {
  const rows = replyDisclosureRows({ ...cloud, runtime: 'owner_device', credentials: null, provider: null, providerLabel: null, model: null });
  assert.deepEqual(rows, [
    'Agent: Scout', 'Runs for: Olivia', 'Requested by: Rui', 'Ran on: Olivia\'s Mac',
    'Model: Chosen on Olivia\'s Mac. Kordi isn\'t told which one.',
  ]);
});

test('PiP is described from the server features', () => {
  assert.equal(pipDisclosureText('Anthropic'), 'PiP is Kordi\'s built-in plan helper. It runs on Anthropic through Kordi\'s account.');
});

const agentReply: Message = {
  id: 'reply-1', role: 'external-agent', sender: 'Scout', senderOwnerName: 'Olivia', senderType: 'agent', text: '', time: '',
  agentRunRef: { ownerAccountId: 'acct_o', requestId: 'request-1' },
  turn: turn({ sessionId: 'session:group:g', assistantText: 'Saturday works' }),
};

test('reply targets come from the stored run and fill gaps from a direct chat', () => {
  const target = replyDisclosureTargetForMessage(agentReply);
  assert.deepEqual(replyDisclosureRequestFor(target!, {}), {
    sessionId: 'session:group:g', reply: { key: 'reply-1', requestId: 'request-1', ownerAccountId: 'acct_o' },
  });
  const direct: ReplyDisclosureTarget = { ...target!, sessionId: null, ownerAccountId: null };
  const context = { sessionId: 'session:direct-person:acct_me:acct_peer', accountId: 'acct_me' };
  assert.equal(replyDisclosureRequestFor(direct, context)?.reply.ownerAccountId, 'acct_peer');
  assert.equal(replyDisclosureRequestFor({ ...direct, role: 'owned-agent' }, context)?.reply.ownerAccountId, 'acct_me');
  // A local-only chat cannot be looked up.
  assert.equal(replyDisclosureRequestFor(direct, { sessionId: 'desktop:local', accountId: 'acct_me' }), null);
  assert.equal(replyDisclosureTargetForMessage({ ...agentReply, role: 'person', turn: undefined }), null);
});

test('the AI chip opens About this reply only where Kordi can describe the reply', () => {
  const chip = renderToStaticMarkup(createElement(AgentAiChip, { message: agentReply }));
  assert.match(chip, /<button[^>]*aria-label="AI agent, about this reply"[^>]*>AI<\/button>/);
  const local: Message = { ...agentReply, agentRunRef: null, turn: turn({ sessionId: 'desktop:local' }) };
  assert.equal(messageOffersReplyDisclosure(local), false);
  const label = renderToStaticMarkup(createElement(AgentAiChip, { message: local }));
  assert.match(label, /aria-label="AI agent"/);
  assert.doesNotMatch(label, /<button/);
  assert.equal(messageOffersReplyDisclosure({ ...agentReply, turn: turn({ sessionId: 'session:group:g', completed: false }) }), false);
  assert.equal(messageOffersReplyDisclosure({ id: 'pip', role: 'person', text: 'Plan', time: '', senderProfileImageUrl: KORDI_PIP_AVATAR_URL }), true);
});

test('the Threads layout header shows the same AI chip on agent messages only', () => {
  const agent = renderToStaticMarkup(createElement(ThreadMessageHeader, { msg: agentReply, name: 'Scout', ownerName: 'Olivia', ai: true }));
  assert.match(agent, /aria-label="AI agent, about this reply"/);
  const person = renderToStaticMarkup(createElement(ThreadMessageHeader, { msg: { ...agentReply, role: 'person' }, name: 'Rui' }));
  assert.doesNotMatch(person, /AI agent/);
});

function fakeApi(replyDisclosures: AgentTrustCalls['replyDisclosures'], providerLabel: string | null = 'OpenAI') {
  const calls = { replyDisclosures, aiFeatures: async () => ({ pip: { available: true, providerLabel } }) } as unknown as AgentTrustCalls;
  return { session: async () => ({ token: 'token', accountId: 'acct_me' }), calls } satisfies AgentTrustApi;
}

test('lookups in one tick share one request; misses and failures are not cached', async () => {
  clearReplyDisclosureCache();
  const batches: ReplyDisclosureRequest[][] = [];
  const api = fakeApi(async (_token, _session, replies) => {
    batches.push(replies);
    return replies.filter((reply) => reply.requestId === 'request-1').map((reply) => ({ ...cloud, key: reply.key }));
  });
  const [first, second] = await Promise.all([
    loadReplyDisclosure('session:group:g', { key: 'a', requestId: 'request-1', ownerAccountId: 'acct_o' }, api),
    loadReplyDisclosure('session:group:g', { key: 'b', requestId: 'request-2', ownerAccountId: 'acct_o' }, api),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 2);
  assert.equal(first?.agentName, 'Scout');
  assert.equal(second, null);
  await loadReplyDisclosure('session:group:g', { key: 'a2', requestId: 'request-1', ownerAccountId: 'acct_o' }, api);
  assert.equal(batches.length, 1, 'answers are cached per run');
  await loadReplyDisclosure('session:group:g', { key: 'b', requestId: 'request-2', ownerAccountId: 'acct_o' }, api);
  assert.equal(batches.length, 2, 'misses are asked again');
  clearReplyDisclosureCache();
});

async function openDialog(api: AgentTrustApi, message: Message) {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const root = createRoot(host);
  await act(async () => { root.render(createElement(AgentReplyDisclosureHost, { sessionId: 'session:group:g', accountId: 'acct_me', api })); });
  await act(async () => { requestReplyDisclosure(message); });
  await flushReactUpdates();
  return {
    host, opener,
    async close() { await act(async () => root.unmount()); installed.restore(); },
  };
}

test('the dialog shows the server answer, traps focus, and returns it on Escape', async () => {
  clearReplyDisclosureCache();
  const view = await openDialog(fakeApi(async (_t, _s, replies) => replies.map((reply) => ({ ...cloud, key: reply.key }))), agentReply);
  try {
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog, 'dialog is open');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.match(dialog.textContent ?? '', /About this reply/);
    assert.match(dialog.textContent ?? '', /Written by AI/);
    assert.match(dialog.textContent ?? '', /Model: gpt-5\.5 \(OpenAI\)/);
    assert.match(dialog.textContent ?? '', /The AI label comes from the sender's Kordi app/);
    assert.ok(dialog.contains(document.activeElement), 'focus moves into the dialog');
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(document.body.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, view.opener, 'focus returns to the opener');
  } finally {
    await view.close();
    clearReplyDisclosureCache();
  }
});

test('missing, failed, and PiP replies use their own copy', async () => {
  clearReplyDisclosureCache();
  let view = await openDialog(fakeApi(async () => []), agentReply);
  try {
    assert.match(document.body.textContent ?? '', /Details aren't available for this reply\./);
  } finally { await view.close(); clearReplyDisclosureCache(); }

  view = await openDialog(fakeApi(async () => { throw new CloudAuthError('server_error', 'down', 500); }), agentReply);
  try {
    assert.match(document.body.querySelector('[role="alert"]')?.textContent ?? '', /Couldn't load details\. Try again\./);
  } finally { await view.close(); clearReplyDisclosureCache(); }

  view = await openDialog(fakeApi(async () => { throw new CloudAuthError('unknown', 'not a member', 404); }), agentReply);
  try {
    assert.match(document.body.textContent ?? '', /Details aren't available for this reply\./);
  } finally { await view.close(); clearReplyDisclosureCache(); }

  clearAiFeaturesCache();
  const pip: Message = { id: 'pip-1', role: 'person', sender: 'PiP', text: 'Plan updated', time: '', senderProfileImageUrl: KORDI_PIP_AVATAR_URL };
  view = await openDialog(fakeApi(async () => { throw new Error('PiP is never looked up'); }, 'Google'), pip);
  try {
    const text = document.body.textContent ?? '';
    assert.match(text, /Runs for: Kordi/);
    assert.match(text, /It runs on Google through Kordi's account\./);
    assert.doesNotMatch(text, /Requested by/);
  } finally { await view.close(); clearAiFeaturesCache(); }
});

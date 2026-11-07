import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { cloudAgentSharedFailure, cloudAgentViewerFailureText } from '../src/features/cloud/cloudAgentFailureNotices';
import { encodeCloudAgentResponse, parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { cloudGroupMessageRuntimeFields } from '../src/features/cloud/cloudGroupDecoding';
import { LiveChatTurnCard } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const OWNER = 'human:acct_owner';
const MEMBER = 'human:acct_member';
const agentIdentity = {
  id: 'agent:cloud-agent:acct_owner',
  kind: 'agent',
  displayName: 'Pebble',
  ownerIdentityId: OWNER,
} as CanonicalIdentity;
const identities = new Map([[agentIdentity.id, agentIdentity]]);

function failedReply(content: Record<string, unknown>): CanonicalSessionMessage {
  return {
    id: 'msg:cloud-agent:reply-1',
    sessionId: 'session:group:g1',
    senderIdentityId: agentIdentity.id,
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: '',
    content: {
      sender: 'Pebble',
      deliveryState: 'failed',
      requestId: 'msg:request-1',
      replyToMessageId: 'msg:request-1',
      ...content,
    },
    parentMessageId: 'msg:request-1',
    status: 'failed',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:reply-1',
  } as unknown as CanonicalSessionMessage;
}

function render(message: CanonicalSessionMessage, viewer: string) {
  const mapped = mapCanonicalMessage(message, identities, viewer);
  assert.ok(mapped?.turn);
  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    turn: mapped.turn,
    historical: true,
    showReasoning: true,
    onOpenAuthSettings: mapped.role === 'owned-agent' ? () => undefined : undefined,
  }));
  return { mapped, markup };
}

test('the owner sees why the reply failed and a Reconnect link that opens provider settings', async () => {
  const message = failedReply({ error: "Pebble couldn't reply.", failureCode: 'provider_auth_rejected' });
  const mapped = mapCanonicalMessage(message, identities, OWNER);
  assert.equal(mapped?.role, 'owned-agent');
  assert.equal(mapped?.turn?.error, 'Your AI provider connection expired.');

  await withJsdomRoot(async (mount) => {
    let opened = 0;
    const host = await mount(createElement(LiveChatTurnCard, {
      turn: mapped!.turn!,
      historical: true,
      showReasoning: true,
      onOpenAuthSettings: () => { opened += 1; },
    }));
    assert.match(host.textContent ?? '', /Your AI provider connection expired\./);
    assert.doesNotMatch(host.textContent ?? '', /Sign in/i);
    const link = host.querySelector<HTMLButtonElement>('.app-error-line-action');
    assert.equal(link?.textContent, 'Reconnect');
    await act(async () => link?.click());
    assert.equal(opened, 1);
  });
});

test('the owner sees the provider name when this Mac kept the raw error', () => {
  const { markup } = render(failedReply({
    error: 'ChatGPT OAuth credentials are not usable. Sign in to ChatGPT again, or switch this provider to an OpenAI API key.',
    failureCode: 'provider_auth_rejected',
  }), OWNER);
  assert.match(markup, /Your ChatGPT connection expired\./);
  assert.match(markup, />Reconnect</);
  assert.doesNotMatch(markup, /Sign in|OAuth/);
});

test('another member sees only that the agent could not reply', () => {
  for (const content of [
    { error: "Pebble couldn't reply.", failureCode: 'provider_auth_rejected' },
    { error: "Pebble couldn't reply.", failureCode: 'missing_provider_auth' },
    { error: "Pebble couldn't reply.", failureCode: 'model_unavailable' },
    { error: 'Network request failed: upstream refused a private host', failureCode: 'failed' },
  ]) {
    const { mapped, markup } = render(failedReply(content), MEMBER);
    assert.equal(mapped.role, 'external-agent');
    assert.equal(mapped.turn?.error, "Pebble couldn't reply.");
    assert.doesNotMatch(markup, /provider|connection|model|account|upstream|app-error-line-action/i, JSON.stringify(content));
  }
});

test('a free-text failure older builds stored reads as the neutral line for members', () => {
  for (const error of [
    'Sign in again to use this account.',
    'No provider configured yet.',
    'Reconnect your account to run your agent.',
    'This model is not available for the selected account.',
    'Cloud fallback could not complete this request because the configured provider/model failed.',
  ]) {
    const member = render(failedReply({ error }), MEMBER);
    assert.equal(member.mapped.turn?.error, "Pebble couldn't reply.", error);
    assert.doesNotMatch(member.markup, /Sign in|provider|account|app-error-line-action/i, error);
  }
  // The owner still reads the old line, worded as a provider connection.
  const owner = render(failedReply({ error: 'Sign in again to use this account.' }), OWNER);
  assert.match(owner.markup, /Your AI provider connection expired\./);
  assert.match(owner.markup, />Reconnect</);
  assert.doesNotMatch(owner.markup, /Sign in/);
});

test('an offline notice the requester wrote stays as written', () => {
  const offline = failedReply({ error: 'Alex and Pebble are offline.' });
  const { mapped } = render({ ...offline, sourceEventId: 'cloud-group-agent-offline:msg:request-1:acct_owner' }, MEMBER);
  assert.equal(mapped.turn?.error, 'Alex and Pebble are offline.');
});

test('a failed reply shares a neutral line and its code, never the reason', () => {
  const raw = 'ChatGPT OAuth credentials are not usable. Sign in to ChatGPT again, or switch this provider to an OpenAI API key.';
  const shared = cloudAgentSharedFailure(raw, 'Pebble');
  assert.deepEqual(shared, { text: "Pebble couldn't reply.", failureCode: 'provider_auth_rejected' });

  const body = encodeCloudAgentResponse({ requestId: 'msg:request-1', deliveryState: 'failed', ...shared });
  const parsed = parseCloudAgentResponse(body);
  assert.equal(parsed?.text, "Pebble couldn't reply.");
  assert.equal(parsed?.failureCode, 'provider_auth_rejected');
  // A completed reply never carries a failure code.
  const complete = parseCloudAgentResponse(encodeCloudAgentResponse({
    requestId: 'msg:request-1', text: 'Hi', deliveryState: 'complete', failureCode: 'failed',
  }));
  assert.equal(complete?.failureCode, undefined);

  assert.deepEqual(cloudGroupMessageRuntimeFields({ deliveryState: 'failed', failureCode: 'missing_provider_auth' }).failureCode, 'missing_provider_auth');
  assert.equal(cloudGroupMessageRuntimeFields({ deliveryState: 'failed', failureCode: 'made_up' }).failureCode, undefined);
});

test('the owner line for each failure never asks to sign in', () => {
  for (const failureCode of ['provider_auth_rejected', 'missing_provider_auth', 'hosted_credentials_unavailable', 'model_unavailable', 'model_provider_error', 'sandbox_error', 'failed']) {
    const text = cloudAgentViewerFailureText({ error: "Pebble couldn't reply.", failureCode, viewerOwnsAgent: true, agentName: 'Pebble' });
    assert.doesNotMatch(text, /sign in/i, failureCode);
  }
});

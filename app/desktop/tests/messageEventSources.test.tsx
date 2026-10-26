import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';

import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import { withJsdomRoot } from './helpers/mountWithJsdom';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { CLOUD_AGENT_SOURCE_LIMIT, messageEventSourcesField, parseCloudAgentSources } from '../src/features/cloud/cloudAgentSources';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/cloudSelfAgentCanonicalSync';
import { normalizeCloudSelfAgentRestoreMessage } from '../src/features/cloud/cloudSelfAgentRestoreMessage';
import { MessageEventSourceChips } from '../src/kordi-app/components/messageEventSources';
import { messageEventSourceProvider } from '../src/kordi-app/components/messageEventSourceProviders';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import { messageSnapshotKey } from '../src/kordi-app/components/transcriptMessageSnapshot';
import type { CanonicalSessionMessage, CanonicalSessionState, Message } from '../src/kordi-app/types';

const sources = [
  { eventId: 'cnevt_airbnb', provider: 'gmail', title: 'Airbnb · Sam' },
  { eventId: 'cnevt_lab', provider: 'google_calendar', title: 'Lab sync' },
  { eventId: 'cnevt_pr', provider: 'github', title: '#412 review requested' },
];

function outreachBody(extra: Record<string, unknown> = {}) {
  const envelope = {
    kind: 'agent-response', requestId: 'personal_agent_eval_8f3c', text: 'Lab sync moved to 10 am Thursday.',
    deliveryState: 'complete', sources, ...extra,
  };
  return `kordi-cloud-agent-response:${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`;
}

const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Alex', primaryEmail: 'alex@example.test', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};

function outreachMessage(sessionId: string): CloudMessage {
  return {
    messageId: 'msg_outreach', fromAccountId: account.accountId, toAccountId: account.accountId, body: outreachBody(),
    direction: 'incoming', sessionId, createdAt: '2026-10-25T14:40:00Z', deliveredAt: null, readAt: null,
  };
}

function canonicalState(sessions: CanonicalSessionState['sessions'] = [], identities: CanonicalSessionState['identities'] = []) {
  return {
    sessions, identities, messages: [], participants: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
    profile: { id: 'profile', humanIdentityId: 'human:me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
    storagePath: '/tmp/canonical.sqlite3',
  } as CanonicalSessionState;
}

test('sources keep their order and drop malformed, repeated and surplus entries', () => {
  const parsed = parseCloudAgentSources([
    ...sources,
    { eventId: 'cnevt_airbnb', provider: 'gmail', title: 'Repeated' },
    { eventId: '', provider: 'gmail', title: 'No id' },
    { eventId: 'cnevt_noprovider', title: 'No provider' },
    'cnevt_string', null, ['cnevt_array'],
    { eventId: ' cnevt_slack ', provider: ' Slack ', title: `  ${'x'.repeat(80)}  ` },
  ]);
  assert.deepEqual(parsed.map((source) => source.eventId), ['cnevt_airbnb', 'cnevt_lab', 'cnevt_pr', 'cnevt_slack']);
  assert.equal(parsed[0]!.title, 'Airbnb · Sam');
  assert.equal(parsed[3]!.provider, 'slack');
  assert.equal(parsed[3]!.title.length, 60);
  assert.deepEqual(parseCloudAgentSources({ eventId: 'x' }), []);
  assert.deepEqual(parseCloudAgentSources(undefined), []);
  const many = Array.from({ length: 20 }, (_, index) => ({ eventId: `cnevt_${index}`, provider: 'gmail', title: `Mail ${index}` }));
  assert.equal(parseCloudAgentSources(many).length, CLOUD_AGENT_SOURCE_LIMIT);
  assert.deepEqual(messageEventSourcesField([]), {});
  assert.deepEqual(messageEventSourcesField(sources), { eventSources: sources });
});

test('an agent-response envelope keeps its sources through the self-agent restore', () => {
  assert.deepEqual(parseCloudAgentResponse(outreachBody())?.sources, sources);
  assert.equal(parseCloudAgentResponse(outreachBody({ sources: 'none' }))?.sources, undefined);
  const restored = normalizeCloudSelfAgentRestoreMessage(outreachMessage('session:self-agent:acct_me:personal:cloud-agent:acct_me'));
  assert.equal(restored?.responseRequestId, 'personal_agent_eval_8f3c');
  assert.deepEqual(restored?.responseSources, sources);
});

test('an outreach message without a local request becomes an agent message with its sources', () => {
  const sessionId = 'session:self-agent:acct_me:personal:cloud-agent:acct_me';
  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [outreachMessage(sessionId)], state: canonicalState() });
  const reply = plan.messageRequests.find((request) => request.senderRole === 'owned-agent');
  assert.ok(reply);
  assert.equal(reply.sessionId, sessionId);
  assert.equal(reply.contentText, 'Lab sync moved to 10 am Thursday.');
  assert.equal(reply.senderIdentityId, 'agent:cloud-self:acct_me');
  assert.deepEqual((reply.content as Record<string, unknown>).sources, sources);
});

test('an outreach message in a Factory agent personal session comes from that agent', () => {
  const sessionId = 'session:self-agent:acct_me:personal:cloud_agent_inbox';
  const identityId = 'agent:cloud-agent:cloud_agent_inbox';
  const state = canonicalState([{
    id: sessionId, kind: 'direct-agent', title: 'Inbox helper', status: 'active',
    createdByIdentityId: 'human:me', primaryIdentityId: identityId,
    metadata: {
      createdFrom: 'chat-create-flow', agentId: 'cloud-agent:cloud_agent_inbox', cloudAgentId: 'cloud_agent_inbox',
      personalAgent: { agentId: 'cloud_agent_inbox' },
    },
    createdAtMs: 1, updatedAtMs: 1,
  }], [{
    id: identityId, kind: 'agent', displayName: 'Inbox helper', agentId: 'cloud-agent:cloud_agent_inbox',
    metadata: { agentId: 'cloud-agent:cloud_agent_inbox', isOwned: true }, createdAtMs: 1, updatedAtMs: 1,
  }] as CanonicalSessionState['identities']);
  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [outreachMessage(sessionId)], state });
  const reply = plan.messageRequests.find((request) => request.senderRole === 'owned-agent');
  assert.equal(reply?.senderIdentityId, identityId);
  assert.deepEqual((reply?.content as Record<string, unknown>).sources, sources);
});

test('stored sources become the transcript message event sources', () => {
  const message: CanonicalSessionMessage = {
    id: 'msg:cloud:self:outreach', sessionId: 'session:self-agent:acct_me:personal:cloud-agent:acct_me',
    senderIdentityId: 'agent:cloud-self:acct_me', senderRole: 'owned-agent', messageKind: 'agent-turn',
    contentText: 'Lab sync moved to 10 am Thursday.',
    content: { deliveryState: 'complete', sources: [...sources, { eventId: 'cnevt_bad' }] },
    status: 'complete', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-self-agent',
  };
  const mapped = mapCanonicalMessage(message, new Map());
  assert.ok(mapped?.turn);
  assert.deepEqual(mapped.eventSources, sources);
  assert.equal(mapCanonicalMessage({ ...message, content: { deliveryState: 'complete' } }, new Map())?.eventSources, undefined);
});

test('a change of sources changes the bubble snapshot key', () => {
  const base = { id: 'm', role: 'owned-agent', text: '', time: '14:40' } as Message;
  assert.notEqual(messageSnapshotKey(base), messageSnapshotKey({ ...base, eventSources: sources }));
});

test('providers show their display names, and unknown ones their capitalized id', () => {
  assert.equal(messageEventSourceProvider('gmail').name, 'Gmail');
  assert.equal(messageEventSourceProvider('google_calendar').name, 'Calendar');
  assert.equal(messageEventSourceProvider('calendar').name, 'Calendar');
  assert.equal(messageEventSourceProvider('GitHub').name, 'GitHub');
  assert.equal(messageEventSourceProvider('slack').name, 'Slack');
  assert.equal(messageEventSourceProvider('notion').name, 'Notion');
  assert.equal(messageEventSourceProvider('linear_app').name, 'Linear app');
  assert.equal(messageEventSourceProvider('').name, 'Source');
  // Inherited object members are not providers.
  assert.equal(messageEventSourceProvider('constructor').name, 'Constructor');
  assert.equal(messageEventSourceProvider('__proto__').name, 'Proto');
  assert.equal(messageEventSourceProvider('toString').name, 'Tostring');
  assert.equal(typeof messageEventSourceProvider('hasOwnProperty').icon, 'object');
});

test('source chips render the provider and the muted title under the message', async () => {
  await withJsdomRoot(async (mount) => {
    const host = await mount(<MessageEventSourceChips sources={sources} />);
    const list = host.querySelector('ul[aria-label="Sources"]');
    assert.ok(list);
    const chips = [...list.querySelectorAll('li')];
    assert.deepEqual(chips.map((chip) => chip.querySelector('span')?.textContent), ['Gmail', 'Calendar', 'GitHub']);
    assert.deepEqual(chips.map((chip) => chip.querySelector('em')?.textContent), ['Airbnb · Sam', 'Lab sync', '#412 review requested']);
    assert.equal(chips[0]!.getAttribute('data-event-source-provider'), 'gmail');
    assert.ok(chips.every((chip) => chip.querySelector('svg[aria-hidden="true"]')));
    const empty = await mount(<MessageEventSourceChips sources={[]} />);
    assert.equal(empty.querySelector('ul'), null);
  });
});

test('an agent turn with sources shows the chips under its bubble', async () => {
  const mapped = mapCanonicalMessage({
    id: 'msg:cloud:self:outreach', sessionId: 'session:self-agent:acct_me:personal:cloud-agent:acct_me',
    senderIdentityId: 'agent:cloud-self:acct_me', senderRole: 'owned-agent', messageKind: 'agent-turn',
    contentText: 'Lab sync moved to 10 am Thursday.', content: { deliveryState: 'complete', sources },
    status: 'complete', sequenceNum: 1, createdAtMs: Date.UTC(2026, 9, 25, 14, 40), updatedAtMs: 1, sourceTransport: 'cloud-self-agent',
  }, new Map());
  assert.ok(mapped?.turn);
  await withJsdomRoot(async (mount) => {
    const host = await mount(<MessageBubble msg={mapped} />);
    assert.match(host.textContent ?? '', /Lab sync moved to 10 am Thursday\./);
    const chips = [...host.querySelectorAll('ul[aria-label="Sources"] li')];
    assert.deepEqual(chips.map((chip) => chip.textContent), ['GmailAirbnb · Sam', 'CalendarLab sync', 'GitHub#412 review requested']);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse, parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import {
  cloudSelfAgentTerminalReply,
  settledCloudSelfAgentTurn,
} from '../src/features/cloud/cloudSelfAgentTerminalReply';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/useCloudCollaborationState';
import { LiveChatTurnCard } from '../src/kordi-app/components/transcriptLiveTurns';
import type { CanonicalSessionMessage, CanonicalSessionState, DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const sessionId = 'session:reply-ending';
const identities = [
  { id: 'human:test', kind: 'human', displayName: 'Test user', source: 'local', createdAtMs: 1, updatedAtMs: 1 },
  { id: 'agent:test', kind: 'agent', displayName: 'Test agent', source: 'local', ownerIdentityId: 'human:test', createdAtMs: 1, updatedAtMs: 1 },
] as CanonicalSessionState['identities'];
const identityById = new Map(identities.map((identity) => [identity.id, identity]));

function reply(overrides: Partial<CanonicalSessionMessage>): CanonicalSessionMessage {
  return {
    id: 'canonical:reply', sessionId, senderIdentityId: 'agent:test', senderRole: 'owned-agent',
    messageKind: 'agent-turn', contentText: 'Disk usage is 40% on', content: {}, parentMessageId: 'request:test',
    status: 'cancelled', sequenceNum: 2, createdAtMs: 9_000, updatedAtMs: 9_000, contentHash: null,
    sourceTransport: 'cloud-self-agent', sourceEventId: 'event:reply', ...overrides,
  };
}

function render(turn: DesktopChatTurnSnapshot) {
  return renderToStaticMarkup(createElement(LiveChatTurnCard, { showReasoning: true, turn, historical: true }));
}

test('the response envelope carries the ending and older replies decode without it', () => {
  const stopped = parseCloudAgentResponse(encodeCloudAgentResponse({
    requestId: 'request', text: 'Partial', deliveryState: 'cancelled', ending: 'stopped',
  }));
  assert.equal(stopped?.ending, 'stopped');
  const legacy = parseCloudAgentResponse(encodeCloudAgentResponse({
    requestId: 'request', text: 'Request stopped.', deliveryState: 'cancelled',
  }));
  assert.equal(legacy?.ending, undefined);
  assert.equal(legacy?.text, 'Request stopped.');
});

for (const [ending, status, footer] of [['stopped', 'cancelled', 'Stopped'], ['interrupted', 'failed', 'Interrupted']] as const) {
  test(`a ${status} reply keeps its partial text with the ${footer} footer`, () => {
    const mapped = mapCanonicalMessage(reply({ status, content: { deliveryState: status, ending } }), identityById, 'human:test')!;
    const turn = mapped.turn!;
    assert.equal(turn.assistantText, 'Disk usage is 40% on');
    assert.equal(turn.ending, ending);
    assert.equal(turn.error, null);
    assert.equal(turn.completed, true);
    const html = render(turn);
    assert.equal(html.split('Disk usage is 40% on').length - 1, 1);
    assert.match(html, new RegExp(`data-reply-ending="${ending}"[^>]*>${footer}<`));
    assert.match(html, /app-message-footer app-live-turn-ending[^"]*text-\[11px\]/);
    assert.ok(!html.includes('app-live-assistant-answer-cancelled'));
    assert.ok(!html.includes('Request canceled'));
    assert.ok(!html.includes('app-live-turn-error'));
  });
}

test('a stopped reply without text shows only the short notice', () => {
  const mapped = mapCanonicalMessage(reply({ contentText: 'Request stopped.', content: { deliveryState: 'cancelled' } }), identityById, 'human:test')!;
  const html = render(mapped.turn!);
  assert.equal(html.split('Request stopped.').length - 1, 1);
  assert.ok(!html.includes('data-reply-ending'));
});

test('cloud sync keeps the partial text and the ending of an interrupted reply', () => {
  const account = {
    accountId: 'acct_me', displayName: 'Me', primaryEmail: 'me@example.com', avatarUrl: null,
    avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
  } as CloudAccount;
  const createdAt = '2026-10-09T06:00:00.000Z';
  const request: CloudMessage = {
    messageId: 'msg_request', fromAccountId: 'acct_me', toAccountId: 'acct_me', body: 'Check disk usage',
    createdAt, deliveredAt: null, readAt: null, sessionId,
  };
  const interrupted: CloudMessage = {
    ...request, messageId: 'msg_reply', createdAt: '2026-10-09T06:00:05.000Z',
    body: encodeCloudAgentResponse({ requestId: request.messageId, text: 'Disk usage is 40% on', deliveryState: 'failed', ending: 'interrupted' }),
  };
  const state = {
    sessions: [], identities: [], participants: [], messages: [], delegatedExchanges: [], presence: [], contextSnapshots: [],
    profile: { id: 'profile', storageRoot: '/tmp/device-a', humanIdentityId: 'human:acct_me', createdAtMs: 1, updatedAtMs: 1 },
    storagePath: '/tmp/device-a/canonical.sqlite3',
  } as unknown as CanonicalSessionState;
  const plan = planCloudSelfAgentCanonicalSync({ account, messages: [request, interrupted], state });
  const response = plan.messageRequests.find((message) => message.senderRole === 'owned-agent');
  assert.equal(response?.status, 'failed');
  assert.equal(response?.contentText, 'Disk usage is 40% on');
  assert.equal(response?.content?.ending, 'interrupted');
  assert.equal(response?.content?.error, undefined);
});

test('the terminal reply keeps streamed text on stop and on a lost lease', () => {
  const base = { status: 'cancelled', succeeded: false, assistantText: 'Disk usage is', error: null, message: '' };
  assert.deepEqual(
    cloudSelfAgentTerminalReply({ turn: base, streamedText: 'Disk usage is', stopRequested: true, leaseLost: false }),
    { deliveryState: 'cancelled', text: 'Disk usage is', ending: 'stopped' },
  );
  // A lost lease cancels the native turn too; it is not a user stop.
  assert.deepEqual(
    cloudSelfAgentTerminalReply({ turn: base, stopRequested: false, leaseLost: true }),
    { deliveryState: 'failed', text: 'Disk usage is', ending: 'interrupted' },
  );
  assert.deepEqual(
    cloudSelfAgentTerminalReply({ turn: { ...base, assistantText: '' }, stopRequested: true, leaseLost: false }),
    { deliveryState: 'cancelled', text: 'Request stopped.' },
  );
  assert.deepEqual(
    cloudSelfAgentTerminalReply({ turn: { ...base, status: 'failed', assistantText: '', error: 'Provider failed.' }, stopRequested: false, leaseLost: false }),
    { deliveryState: 'failed', text: 'Provider failed.' },
  );
  const running = {
    id: 'turn', sessionId, prompt: 'p', status: 'writing', message: '', assistantText: 'Disk usage is', thinkingText: '',
    tools: [], completed: false, succeeded: false, hostedRunStatus: 'running',
  } as DesktopChatTurnSnapshot;
  const settled = settledCloudSelfAgentTurn(running, { deliveryState: 'failed', text: 'Disk usage is', ending: 'interrupted' }, 5);
  assert.equal(settled.completed, true);
  assert.equal(settled.status, 'failed');
  assert.equal(settled.hostedRunStatus, undefined);
  assert.equal(settled.error, null);
  assert.match(render(settled), />Interrupted</);
});

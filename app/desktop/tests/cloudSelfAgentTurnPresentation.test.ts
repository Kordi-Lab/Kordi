import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withLiveTurn } from '../src/features/cloud/cloudGroupLiveProjection';
import { settledCloudSelfAgentTurn } from '../src/features/cloud/cloudSelfAgentTerminalReply';
import { createCloudSelfAgentTurnPresenter } from '../src/features/cloud/cloudSelfAgentTurnPresentation';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { canDisplayAgentTurn, shouldShowAgentWaitingAnimation } from '../src/features/chat/agentProcessingVisibility';
import type { CanonicalIdentity, CanonicalSessionMessage, DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const sessionId = '00000000-0000-4000-8000-0000000000cc';
const turn = (status: string, text = '', completed = false): DesktopChatTurnSnapshot => ({
  id: 'native', sessionId, prompt: 'hi', status, message: 'Working…', assistantText: text,
  thinkingText: '', tools: [], completed, succeeded: false, startedAtMs: 1, replyToMessageId: 'wire',
});
const row: CanonicalSessionMessage = {
  id: 'msg:cloud:self:response:wire', sessionId, senderIdentityId: 'agent:cloud-self:acct_me', senderRole: 'owned-agent',
  messageKind: 'agent-turn', contentText: '', content: { cloudRequestMessageId: 'wire', requestId: 'req', replyToMessageId: 'req', deliveryState: 'processing' },
  parentMessageId: 'req', delegatedExchangeId: null, status: 'processing', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2,
  sourceTransport: 'cloud-self-agent', sourceEventId: 'wire',
};
const identities = new Map<string, CanonicalIdentity>([
  ['agent:cloud-self:acct_me', { id: 'agent:cloud-self:acct_me', kind: 'agent', displayName: 'Agent', source: 'cloud', ownerIdentityId: 'human:acct_me', avatarKey: 'a', createdAtMs: 1, updatedAtMs: 1 } as CanonicalIdentity],
]);
const present = (snapshot: DesktopChatTurnSnapshot) => mapCanonicalMessage(withLiveTurn(row, snapshot), identities, 'human:acct_me')!.turn!;

test('a native turn that was just admitted or is finalizing keeps the processing row visible', () => {
  for (const status of ['starting', 'finalizing']) {
    const presented = present(turn(status));
    assert.equal(canDisplayAgentTurn(presented, []), true, `${status} shows`);
    assert.equal(shouldShowAgentWaitingAnimation(presented), true, `${status} animates`);
  }
  assert.equal(present(turn('thinking')).status, 'thinking', 'a displayable native status is kept');
  assert.equal(present(turn('cancelled', '', true)).status, 'cancelled', 'a finished turn keeps its state');
});

test('a stopped reply ends early the way its stored row will', () => {
  const stopped = present(settledCloudSelfAgentTurn(turn('cancelled', 'Partial answer', true), { deliveryState: 'cancelled', text: 'Partial answer', ending: 'stopped' }));
  assert.equal(stopped.completed, true);
  assert.equal(stopped.ending, 'stopped');
  assert.equal(stopped.assistantText, 'Partial answer');
  const bare = present(settledCloudSelfAgentTurn(turn('cancelled', '', true), { deliveryState: 'cancelled', text: 'Request stopped.' }));
  assert.equal(bare.message, 'Request stopped.');
});

test('a stop settles the presented turn once and later running snapshots do not reach it', () => {
  let turns: Record<string, DesktopChatTurnSnapshot> = {};
  const presenter = createCloudSelfAgentTurnPresenter({
    requestMessageId: 'wire', sessionId, canPresent: () => true, setLocalTurns: (update) => { turns = update(turns); },
  });
  presenter.remember(turn('writing', 'Hello, how'));
  assert.equal(turns.wire?.status, 'writing');
  presenter.stop();
  assert.equal(turns.wire?.status, 'cancelled');
  assert.equal(turns.wire?.completed, true);
  assert.equal(turns.wire?.assistantText, 'Hello, how', 'the text streamed so far is kept');
  assert.equal(turns.wire?.ending, 'stopped');
  presenter.remember(turn('cancelling', 'Hello, how'));
  presenter.remember(turn('cancelled', 'Hello, how there', true));
  assert.equal(turns.wire?.status, 'cancelled');
  assert.equal(turns.wire?.completed, true);
  assert.equal(turns.wire?.assistantText, 'Hello, how', 'the native turn no longer changes the reply');
  assert.equal(presenter.streamedText, 'Hello, how there', 'the final text is still recorded for the terminal reply');
  const settled = settledCloudSelfAgentTurn(turn('cancelled', 'Hello, how there', true), { deliveryState: 'cancelled', text: 'Hello, how there', ending: 'stopped' });
  presenter.settle(settled);
  assert.equal(turns.wire, settled, 'the terminal reply is shown');
  presenter.stop();
  assert.equal(turns.wire, settled, 'a second stop changes nothing');
});

test('a stop before any snapshot shows the stopped notice', () => {
  let turns: Record<string, DesktopChatTurnSnapshot> = {};
  const presenter = createCloudSelfAgentTurnPresenter({
    requestMessageId: 'wire', sessionId, canPresent: () => true, setLocalTurns: (update) => { turns = update(turns); },
  });
  presenter.stop();
  assert.equal(turns.wire?.completed, true);
  assert.equal(turns.wire?.status, 'cancelled');
  assert.equal(turns.wire?.assistantText, 'Request stopped.');
});

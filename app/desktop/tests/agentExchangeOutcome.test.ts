import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_EXCHANGE_WAITING as WAITING, AGENT_EXCHANGE_SILENT as SILENT, agentExchangeOutcome } from '../src/features/cloud/agentExchangeOutcome';
import { cloudAgentTurnReplyText } from '../src/features/cloud/cloudAgentReplyText';
import { selectVisibleCloudAgentResponses } from '../src/features/cloud/cloudAgentResponseSelection';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { isInternalCloudAgentControlMessage } from '../src/features/canonical/readModel/messageVisibility';
import { withLiveTurn } from '../src/features/cloud/cloudGroupLiveProjection';
import type { CloudMessage } from '../src/features/cloud/authClient';
import type { CanonicalSessionMessage, DesktopChatTurnSnapshot } from '../src/kordi-app/types';

const turn = (text: string, succeeded = true) => ({ assistantText: text, succeeded, completed: true, status: succeeded ? 'complete' : 'failed', tools: [], thinkingText: '' }) as unknown as DesktopChatTurnSnapshot;

test('only exact structured outcomes are internal; ordinary text and failures remain visible', () => {
  assert.equal(agentExchangeOutcome(WAITING), 'waiting');
  assert.equal(agentExchangeOutcome(SILENT), 'silent');
  for (const text of ['', 'silent', 'I am waiting', `Example: ${SILENT}`, '{"agentExchangeOutcome":"silent","text":"Useful result"}']) assert.equal(agentExchangeOutcome(text), null);
  const row = { messageKind: 'agent-turn', status: 'complete', contentText: WAITING, content: {} } as CanonicalSessionMessage;
  assert.equal(isInternalCloudAgentControlMessage(row), true);
  assert.equal(isInternalCloudAgentControlMessage({ ...row, status: 'failed' }), false);
  assert.equal(isInternalCloudAgentControlMessage({ ...row, messageKind: 'text' }), false);
  assert.equal(isInternalCloudAgentControlMessage({ ...row, contentText: 'The total is 19.' }), false);
});

test('a successful durable receipt replaces redundant parent speech, never a failure', () => {
  const parent = turn('I asked and am waiting.');
  parent.tools = [{ id: 'call', name: 'reach_out', status: 'complete', arguments: '{}', liveOutput: '', resultText: `Delivery receipt: end with ${WAITING}`, isError: false }];
  assert.equal(cloudAgentTurnReplyText(parent), WAITING);
  assert.equal(cloudAgentTurnReplyText({ ...parent, succeeded: false }), '');
  assert.equal(cloudAgentTurnReplyText({ ...parent, tools: [{ ...parent.tools[0], isError: true }] }), parent.assistantText);
  const row = { messageKind: 'agent-turn', status: 'processing', contentText: '', content: {} } as CanonicalSessionMessage;
  assert.equal(isInternalCloudAgentControlMessage(withLiveTurn(row, parent)), true);
});

test('a waiting completion retires prior progress without a speech bubble or reopened pending request', () => {
  const message = (id: string, text: string, deliveryState: 'processing' | 'complete') => ({ messageId: id, fromAccountId: 'owner', createdAt: new Date().toISOString(), body: encodeCloudAgentResponse({ requestId: 'request', text, deliveryState }) }) as CloudMessage;
  const progress = message('progress', 'Thinking', 'processing');
  const waiting = message('waiting', WAITING, 'complete');
  const select = (messages: CloudMessage[]) => selectVisibleCloudAgentResponses(messages, new Map([['request', 'owner']]), () => false, () => false);
  for (const messages of [[progress, waiting], [waiting, progress]]) {
    const result = select(messages);
    assert.equal(result.visibleMessages.length, 0);
    assert.equal(result.responseRequestIds.has('request'), true);
    assert.equal(result.terminalResponseRequestIds.has('request'), true);
  }
  assert.equal(select([message('answer', 'The total is 19.', 'complete')]).visibleMessages.length, 1);
});

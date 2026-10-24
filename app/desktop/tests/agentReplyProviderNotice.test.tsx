import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { cloudAgentTurnReplyText, isCloudAgentProviderFailureNoticeText, isFailedReplyTextOnlyItsError } from '../src/features/cloud/cloudAgentReplyText';
import { LiveChatTurnCard } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage, DesktopChatToolSnapshot } from '../src/kordi-app/types';

// A group agent run that created a document about earlier "No provider configured" failures
// must show its reply, not the provider notice its text mentions.
const agentIdentity = {
  id: 'agent:cloud-agent:acct_owner',
  kind: 'agent',
  displayName: 'Synthetic Agent',
  ownerIdentityId: 'human:acct_owner',
} as CanonicalIdentity;
const identities = new Map([[agentIdentity.id, agentIdentity]]);

const reportText = [
  'Created **“Bug Testing Report”.**',
  '',
  'It covers:',
  '',
  '- Repeated “No provider configured” failures',
  '- Later successful agent replies',
].join('\n');

const documentTool: DesktopChatToolSnapshot = {
  id: 'call_1',
  name: 'create_document',
  status: 'complete',
  arguments: '{"content":"# Bug Testing Report","format":"markdown","title":"Bug Testing Report"}',
  liveOutput: '',
  resultText: '{"attachmentId":"att_agentdoc_1","created":true,"fileName":"bug-testing-report.md","format":"markdown","title":"Bug Testing Report"}',
  isError: false,
};

function agentReply(overrides: {
  contentText: string;
  status?: string;
  content?: Record<string, unknown>;
}): CanonicalSessionMessage {
  return {
    id: 'msg:cloud-agent-processing:msg:ui:request-1:acct_owner',
    sessionId: 'session:group:g1',
    senderIdentityId: agentIdentity.id,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: overrides.contentText,
    content: {
      sender: 'Synthetic Agent',
      deliveryState: 'complete',
      requestId: 'msg:ui:request-1',
      replyToMessageId: 'msg:ui:request-1',
      ...overrides.content,
    },
    parentMessageId: 'msg:ui:request-1',
    status: overrides.status ?? 'received',
    sequenceNum: 2,
    createdAtMs: 2,
    updatedAtMs: 2,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:response-1',
  } as unknown as CanonicalSessionMessage;
}

function renderTurn(message: CanonicalSessionMessage) {
  const mapped = mapCanonicalMessage(message, identities, 'human:acct_owner');
  assert.ok(mapped?.turn);
  const markup = renderToStaticMarkup(createElement(LiveChatTurnCard, {
    showReasoning: true,
    turn: mapped.turn,
    historical: true,
    onOpenAuthSettings: () => undefined,
  }));
  return { mapped, markup };
}

test('a completed reply that mentions the provider notice shows its own text', () => {
  const { mapped, markup } = renderTurn(agentReply({
    contentText: reportText,
    content: {
      tools: [documentTool],
      attachments: [{ attachmentId: 'att_agentdoc_1', name: 'bug-testing-report.md', kind: 'file', mimeType: 'text/markdown' }],
    },
  }));
  assert.equal(mapped.turn?.error, null);
  assert.equal(mapped.turn?.status, 'complete');
  assert.equal(mapped.turn?.assistantText, reportText);
  assert.doesNotMatch(markup, /No provider configured yet\./);
  assert.doesNotMatch(markup, /Open authentication/);
  assert.match(markup, /Later successful agent replies/);
});

test('a completed text-only reply that discusses the notice is still a reply', () => {
  const { mapped } = renderTurn(agentReply({ contentText: reportText }));
  assert.equal(mapped.turn?.error, null);
  assert.equal(mapped.turn?.assistantText, reportText);
});

test('a stored provider failure still shows the notice and the authentication action', () => {
  const { mapped, markup } = renderTurn(agentReply({
    contentText: 'No provider configured yet.',
    status: 'failed',
    content: { deliveryState: 'failed', error: 'No provider configured yet.' },
  }));
  assert.equal(mapped.turn?.status, 'failed');
  assert.match(markup, /No provider configured yet/);
  assert.match(markup, />Open authentication</);
});

test('an older reply whose whole text is the notice still reads as a failure', () => {
  const { mapped } = renderTurn(agentReply({ contentText: 'No provider configured yet.' }));
  assert.equal(mapped.turn?.status, 'failed');
  assert.equal(mapped.turn?.assistantText, '');
});

test('a failed reply whose text is its error shows the error once', () => {
  const sentence = 'The selected model is unavailable for this account. Choose another model.';
  const failed = { deliveryState: 'failed', error: sentence };
  const { mapped, markup } = renderTurn(agentReply({ contentText: sentence, status: 'failed', content: failed }));
  assert.equal(mapped.turn?.assistantText, '');
  assert.equal(mapped.turn?.error, sentence);
  assert.equal(markup.split(sentence).length - 1, 1);
  const partial = renderTurn(agentReply({ contentText: 'Here is part of it.', status: 'failed', content: failed }));
  assert.equal(partial.mapped.turn?.assistantText, 'Here is part of it.');
  assert.equal(partial.mapped.turn?.error, sentence);
  assert.equal(isFailedReplyTextOnlyItsError(' The  SELECTED model\nis unavailable ', 'the selected model is unavailable'), true);
  assert.equal(isFailedReplyTextOnlyItsError('', ''), false);
});

test('only a one-line notice counts as notice text', () => {
  assert.equal(isCloudAgentProviderFailureNoticeText('No provider configured yet.'), true);
  assert.equal(isCloudAgentProviderFailureNoticeText('No OpenAI credentials are available. Add OPENAI_API_KEY or sign in with ChatGPT account access.'), true);
  assert.equal(isCloudAgentProviderFailureNoticeText(reportText), false);
  assert.equal(isCloudAgentProviderFailureNoticeText(''), false);
});

test('a turn that ends on a document tool call replies with the document title', () => {
  const base = { succeeded: true, assistantText: '  ', tools: [documentTool] };
  assert.equal(cloudAgentTurnReplyText(base), 'Created “Bug Testing Report”.');
  assert.equal(cloudAgentTurnReplyText({ ...base, assistantText: 'Done.' }), 'Done.');
  assert.equal(cloudAgentTurnReplyText({ ...base, succeeded: false }), '');
  assert.equal(cloudAgentTurnReplyText({ ...base, tools: [{ ...documentTool, isError: true }] }), '');
  assert.equal(cloudAgentTurnReplyText({ ...base, tools: [{ ...documentTool, name: 'read_session' }] }), '');
});

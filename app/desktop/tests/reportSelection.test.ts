import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ReportSelectedMessagesButton } from '../src/features/safety/ReportSelectedMessagesButton';
import {
  publishReportSelection,
  reportSelectionState,
} from '../src/features/safety/reportSelectionStore';
import { SafetyActionsContext, UNAVAILABLE_SAFETY_ACTIONS } from '../src/features/safety/safetyActions';
import { MessageSelectionBar } from '../src/pages/chatsPage.composerPrimitives';
import type { Message } from '../src/kordi-app/types';

const conversationId = '00000000-0000-4000-8000-0000000000aa';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function message(n: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `entry-${n}`,
    role: 'person',
    sender: 'Bea',
    senderType: 'human',
    senderIdentityId: 'human:acct_bea',
    isOwnMessage: false,
    text: `message ${n}`,
    time: '10:00',
    reactionConversationId: conversationId,
    reactionTargetMessageId: uuid(n),
    ...overrides,
  };
}

const own = (n: number) => message(n, { role: 'user', isOwnMessage: true, sender: 'Me', senderIdentityId: 'human:acct_me' });

test('selected messages report their hosted ids in one chat and name the person', () => {
  assert.deepEqual(reportSelectionState([own(1), message(2), message(3)]).target, {
    accountId: 'acct_bea',
    name: 'Bea',
    conversationId,
    messageIds: [uuid(1), uuid(2), uuid(3)],
  });
});

test('agent messages leave the account to the server', () => {
  const state = reportSelectionState([message(1, {
    role: 'external-agent',
    senderType: 'agent',
    sender: 'Helper',
    senderOwnerName: 'Bea',
    senderIdentityId: 'agent:cloud_agent_x',
  })]);
  assert.equal(state.target?.accountId, null);
  assert.equal(state.target?.name, 'Bea');
});

test('a selection that cannot be reported says why', () => {
  assert.equal(reportSelectionState([]).target, null);
  assert.match(reportSelectionState([own(1), own(2)]).problem ?? '', /from the person you're reporting/);
  assert.match(reportSelectionState([message(1), message(2, { reactionConversationId: uuid(99) })]).problem ?? '', /one chat/);
  assert.match(reportSelectionState([message(1, { reactionTargetMessageId: 'local' })]).problem ?? '', /can't be included/);
  assert.match(reportSelectionState(Array.from({ length: 51 }, (_, index) => message(index + 1))).problem ?? '', /up to 50/);
  assert.equal(reportSelectionState([message(1, { senderIdentityId: 'human:acct_kordi_support' })]).target, null);
  assert.equal(reportSelectionState([message(1, { role: 'owned-agent', senderType: 'agent' })]).target, null, 'your own agent is yours');
});

test('the selection store follows the transcript order and clears with the selection', () => {
  const messages = [message(1), message(2), message(3)];
  publishReportSelection(messages, new Set(['entry-3', 'entry-1']));
  const safety = { ...UNAVAILABLE_SAFETY_ACTIONS, safetyFeaturesAvailable: true };
  const markup = renderToStaticMarkup(createElement(SafetyActionsContext.Provider, { value: safety },
    createElement(ReportSelectedMessagesButton)));
  assert.match(markup, /aria-label="Report 2 selected messages"/);
  assert.doesNotMatch(markup, /disabled=""/);

  publishReportSelection(messages, new Set());
  const cleared = renderToStaticMarkup(createElement(SafetyActionsContext.Provider, { value: safety },
    createElement(ReportSelectedMessagesButton)));
  assert.equal(cleared, '');
});

test('the selection bar shows Report only when the server supports it', () => {
  publishReportSelection([own(1), own(2)], new Set(['entry-1', 'entry-2']));
  const bar = (value: typeof UNAVAILABLE_SAFETY_ACTIONS) => renderToStaticMarkup(createElement(SafetyActionsContext.Provider, { value },
    createElement(MessageSelectionBar, { count: 2, onCancel: () => undefined, onCopy: () => undefined, onForward: () => undefined })));

  const supported = bar({ ...UNAVAILABLE_SAFETY_ACTIONS, safetyFeaturesAvailable: true });
  assert.match(supported, /data-message-selection-report="true"[^>]*disabled=""/, 'only your own messages cannot be reported');
  assert.match(supported, /aria-label="Report 2 selected messages"/);
  assert.doesNotMatch(bar(UNAVAILABLE_SAFETY_ACTIONS), /data-message-selection-report/);
  publishReportSelection([], new Set());
});

test('both selection bars and the message actions publish the selection', () => {
  const sessionPane = readFileSync(new URL('../src/pages/chatsPage.sessionPane.tsx', import.meta.url), 'utf8');
  const actions = readFileSync(new URL('../src/app/useKordiMessageActions.ts', import.meta.url), 'utf8');
  assert.match(sessionPane, /<ReportSelectedMessagesButton \/>/);
  assert.match(actions, /publishReportSelection\(activeConversation\.messages, selectedMessageIds\)/);
});

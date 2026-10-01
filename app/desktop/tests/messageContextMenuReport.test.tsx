import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SafetyActionsContext, UNAVAILABLE_SAFETY_ACTIONS, type SafetyActions } from '../src/features/safety/safetyActions';
import type { ReportTarget } from '../src/features/safety/safetyTypes';
import { MessageContextMenuContent } from '../src/kordi-app/components/messageContextMenuContent';
import type { Message } from '../src/kordi-app/types';
import { mountInDom } from './helpers/safetyDom';

const conversationId = '00000000-0000-4000-8000-0000000000aa';
const messageId = '00000000-0000-4000-8000-000000000001';

function peerMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'entry-1',
    role: 'person',
    sender: 'Bea',
    senderType: 'human',
    senderIdentityId: 'human:acct_bea',
    isOwnMessage: false,
    text: 'hello there',
    time: '10:00',
    reactionConversationId: conversationId,
    reactionTargetMessageId: messageId,
    cloudMessageVersion: 1,
    ...overrides,
  };
}

function available(reports: ReportTarget[] = []): SafetyActions {
  return {
    ...UNAVAILABLE_SAFETY_ACTIONS,
    safetyFeaturesAvailable: true,
    openReport: (target) => { reports.push(target); },
  };
}

function menu(message: Message, safety: SafetyActions | null) {
  const content = createElement(MessageContextMenuContent, { msg: message, onClose: () => undefined });
  return renderToStaticMarkup(safety ? createElement(SafetyActionsContext.Provider, { value: safety }, content) : content);
}

test("Report… appears as a menu item for other people's hosted messages", () => {
  const markup = menu(peerMessage(), available());
  assert.match(markup, /role="menuitem"[^>]*data-message-context-menu-action="report"/);
  assert.match(markup, />Report…</);
});

test('Report… is hidden for own, local, support, and unsupported-server messages', () => {
  assert.doesNotMatch(menu(peerMessage(), null), /data-message-context-menu-action="report"/);
  assert.doesNotMatch(menu(peerMessage({ isOwnMessage: true, role: 'user' }), available()), /action="report"/);
  assert.doesNotMatch(menu(peerMessage({ reactionConversationId: null, reactionTargetMessageId: null }), available()), /action="report"/);
  assert.doesNotMatch(menu(peerMessage({ reactionTargetMessageId: 'local-entry' }), available()), /action="report"/);
  assert.doesNotMatch(menu(peerMessage({ supportContactResponse: true }), available()), /action="report"/);
  assert.doesNotMatch(menu(peerMessage({ senderIdentityId: 'human:acct_kordi_pip' }), available()), /action="report"/);
  assert.doesNotMatch(menu(peerMessage({ role: 'system' }), available()), /action="report"/);
});

test('choosing Report… opens a report about that one message and closes the menu', async () => {
  const dom = await mountInDom();
  const reports: ReportTarget[] = [];
  let closed = 0;
  try {
    await dom.render(createElement(SafetyActionsContext.Provider, { value: available(reports) },
      createElement(MessageContextMenuContent, { msg: peerMessage(), onClose: () => { closed += 1; } })));
    await dom.click(dom.document.querySelector<HTMLButtonElement>('[data-message-context-menu-action="report"]') ?? undefined);

    assert.equal(closed, 1);
    assert.deepEqual(reports, [{
      accountId: 'acct_bea',
      name: 'Bea',
      conversationId,
      messageIds: [messageId],
    }]);
  } finally {
    await dom.cleanup();
  }
});

test("an agent message is reported without naming an account so the server uses the agent's owner", () => {
  const reports: ReportTarget[] = [];
  const markup = menu(peerMessage({
    role: 'external-agent',
    senderType: 'agent',
    sender: 'Helper',
    senderOwnerName: 'Bea',
    senderIdentityId: 'agent:cloud_agent_x',
  }), available(reports));
  assert.match(markup, /action="report"/);
});

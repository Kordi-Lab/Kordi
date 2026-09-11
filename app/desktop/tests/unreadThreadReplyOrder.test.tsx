import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatSyncClient } from '../src/features/cloud/chatSyncClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { threadMessage, type ThreadPage } from '../src/features/cloud/threadAttention';
import type { CloudMessage } from '../src/features/cloud/authClient';
import { useUnreadThreadNavigation } from '../src/pages/useUnreadThreadNavigation';
import { useActiveThread, useThreadTranscript } from '../src/pages/useThreadMessageSummaries';
import { threadRootSource } from '../src/features/chat/messageThreads';
import { threadMessageAction } from '../src/features/chat/messageActionMetadata';
import type { Message } from '../src/kordi-app/types';
import { conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

function serverReply(id: string, sequence: number): CloudMessage {
  return {
    messageId: id, fromAccountId: 'peer', toAccountId: 'viewer', body: id,
    createdAt: '2026-01-01T12:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming',
    conversationSequence: sequence,
  };
}

test('an unread thread renders pending replies below history through server acknowledgement', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const replacements = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  __setSessionBackendForTests({
    load: async () => ({ accountId: 'viewer', token: 'synthetic', expiresAt: '2099-01-01' }),
    save: async () => {}, clear: async () => {},
  });
  const chat = conversation({ id: 'session', canonicalSessionId: 'session' });
  const page: ThreadPage = {
    root: serverReply('thread-root', 1),
    messages: [serverReply('first', 10), serverReply('unread', 20)],
    firstUnreadMessageId: 'unread', nextAfterSequence: null, isThread: true,
  };
  const pageRequest = t.mock.method(ChatSyncClient.prototype, 'threadPage', async () => page);
  const threadRoot = threadMessage(page.root, chat, 'viewer');
  const history = page.messages.map(message => threadMessage(message, chat, 'viewer'));
  const pending: Message = {
    id: 'pending', role: 'user', text: 'Pending reply', time: '12:01',
    timestampMs: Date.parse('2026-01-01T12:01:00Z'), deliveryState: 'sending',
  };
  function Harness({ localReplies, rootOutsidePage = false }: { localReplies: Message[]; rootOutsidePage?: boolean }) {
    const [activeRoot, open] = useState<string | null>(null);
    const navigation = useUnreadThreadNavigation(chat, 'viewer', open, activeRoot);
    const currentConversation = { ...chat, messages: [
      ...(rootOutsidePage ? [{ id: 'recent-main', role: 'person' as const, text: 'Recent main message', time: '12:01' }] : [threadRoot]),
      ...localReplies.map(message => ({ ...message, messageAction: threadMessageAction(threadRootSource(threadRoot, chat.id)!) })),
    ] };
    const { threadProjection } = useThreadTranscript(currentConversation, undefined, undefined, navigation.page?.thread);
    const localThread = useActiveThread(activeRoot, threadProjection, threadProjection.mainMessages);
    const thread = navigation.merge(localThread) ?? navigation.page?.thread;
    return <>
      <button onClick={() => void navigation.load('unread')}>Open unread thread</button>
      {threadProjection.mainMessages.map(message => <div key={message.id} data-main-message-id={message.id} />)}
      <output data-loaded={navigation.page !== null}>
        {thread?.replies.map(message => <div key={message.id} data-reply-id={message.id}>
          {message.id === navigation.page?.first ? <span>New replies</span> : null}
          {message.text}
        </div>)}
      </output>
    </>;
  }
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  const order = () => [...host.querySelectorAll<HTMLElement>('[data-reply-id]')].map(row => row.dataset.replyId);
  try {
    await act(async () => root.render(<Harness localReplies={history} />));
    await act(async () => host.querySelector('button')!.click());
    assert.equal(pageRequest.mock.callCount(), 1);
    assert.equal(host.querySelector('output')?.dataset.loaded, 'true');
    assert.deepEqual(order(), ['first', 'unread']);

    await act(async () => root.render(<Harness localReplies={[...history, pending]} />));
    assert.deepEqual(order(), ['first', 'unread', 'pending']);
    assert.equal(host.querySelector('[data-reply-id="unread"] span')?.textContent, 'New replies');

    // Another reply arrives before the first acknowledgement.
    const second: Message = { ...pending, id: 'pending-second', timestampMs: pending.timestampMs! + 1 };
    await act(async () => root.render(<Harness localReplies={[...history, pending, second]} />));
    assert.deepEqual(order(), ['first', 'unread', 'pending', 'pending-second']);

    const confirmed = { ...pending, conversationSequence: 21, deliveryState: 'sent' as const };
    await act(async () => root.render(<Harness localReplies={[...history, confirmed, second]} />));
    assert.deepEqual(order(), ['first', 'unread', 'pending', 'pending-second']);

    // The older root and confirmed replies need not be in the bounded local page.
    // Pending bubbles must still render without another API response or poll.
    const started = performance.now();
    await act(async () => root.render(<Harness rootOutsidePage localReplies={[pending, second]} />));
    assert.deepEqual(order(), ['first', 'unread', 'pending', 'pending-second']);
    assert.equal(pageRequest.mock.callCount(), 1);
    assert.deepEqual([...host.querySelectorAll<HTMLElement>('[data-main-message-id]')].map(row => row.dataset.mainMessageId), ['recent-main']);
    t.diagnostic(`Pending replies rendered in ${Math.round(performance.now() - started)}ms without polling`);
  } finally {
    await act(async () => root.unmount());
    __setSessionBackendForTests(null);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

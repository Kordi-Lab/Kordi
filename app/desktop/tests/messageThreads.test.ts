import assert from 'node:assert/strict';
import { test } from 'node:test';

import { messagesWithThreadReplyCounts, projectMessageThreads, projectQueuedThreadMessages, threadRootSource } from '../src/features/chat/messageThreads';
import { cloudMessageActionFromRecord } from '../src/features/cloud/cloudMessageActionCodec';
import { threadMessageAction } from '../src/features/chat/messageActionMetadata';
import { buildReplyAttribution } from '../src/features/chat/replyAttribution';
import type { Message } from '../src/kordi-app/types';

function message(id: string, text: string, action?: Message['messageAction']): Message {
  return {
    id,
    role: 'person',
    sender: 'Bob',
    senderType: 'human',
    text,
    time: '12:00',
    messageAction: action,
  };
}

test('thread messages stay out of the main transcript and attach a count to the root', () => {
  const root = message('root', 'Root message');
  const source = threadRootSource(root, 'session');
  assert.ok(source);
  const first = message('reply-1', 'First reply', { schemaVersion: 1, kind: 'thread', source });
  const second = message('reply-2', 'Second reply', { schemaVersion: 1, kind: 'thread', source });
  const agentResponse = { ...message('agent-reply', 'Agent response'), replyToMessageId: 'reply-2' };

  const projection = projectMessageThreads([root, first, second, agentResponse]);

  assert.deepEqual(projection.mainMessages.map((item) => item.id), ['root']);
  assert.equal(projection.mainMessages[0].threadSummary?.replyCount, 3);
  assert.deepEqual(projection.threads.get('root')?.replies.map((item) => item.id), ['reply-1', 'reply-2', 'agent-reply']);
});

test('replying from inside a thread keeps the original root source', () => {
  const root = message('root', 'Root message');
  const source = threadRootSource(root, 'session');
  assert.ok(source);
  const reply = message('reply', 'Reply', { schemaVersion: 1, kind: 'thread', source });

  assert.equal(threadRootSource(reply, 'session')?.sourceMessageId, 'root');
});

test('a received cloud thread reply opens the same shared thread', () => {
  const root = message('root', 'Root message');
  const source = threadRootSource(root, 'session');
  assert.ok(source);
  const receivedAction = cloudMessageActionFromRecord(
    JSON.parse(JSON.stringify(threadMessageAction(source))),
  );
  assert.ok(receivedAction);

  const projection = projectMessageThreads([
    root,
    message('remote-reply', 'Reply from another participant', receivedAction),
  ]);

  assert.equal(projection.mainMessages[0].threadSummary?.replyCount, 1);
  assert.equal(projection.threads.get('root')?.replies[0].id, 'remote-reply');
});

test('an agent response stays in the thread when it targets a reconciled reply alias', () => {
  const root = message('root', 'Root message');
  const source = threadRootSource(root, 'session');
  assert.ok(source);
  const request = {
    ...message('local-request', '@MyKordi hi', threadMessageAction(source)),
    replyToMessageId: 'root',
    replyAliasIds: ['root', 'cloud-request'],
  };
  const response = {
    ...message('agent-response', 'Hello'),
    role: 'owned-agent' as const,
    replyToMessageId: 'cloud-request',
  };

  const projection = projectMessageThreads([root, response, request]);

  assert.deepEqual(projection.mainMessages.map((item) => item.id), ['root']);
  assert.deepEqual(
    projection.threads.get('root')?.replies.map((item) => item.id),
    ['local-request', 'agent-response'],
  );
  assert.equal(projection.threadRootIdByMessageId.get('cloud-request'), 'root');
  assert.equal(projection.threadRootIdByMessageId.get('agent-response'), 'root');
});

test('a reply parent id never replaces the real thread root', () => {
  const root = message('root', 'Root message');
  const source = threadRootSource(root, 'session');
  assert.ok(source);
  const first = {
    ...message('reply-1', 'First reply', threadMessageAction(source)),
    replyToMessageId: 'root',
    replyAliasIds: ['root', 'cloud-reply-1'],
  };
  const second = {
    ...message('reply-2', 'Second reply', threadMessageAction(source)),
    replyToMessageId: 'root',
    replyAliasIds: ['root', 'cloud-reply-2'],
  };

  const projection = projectMessageThreads([root, first, second]);

  assert.equal(projection.threads.get('root')?.root.id, 'root');
  assert.deepEqual(
    projection.threads.get('root')?.replies.map((item) => item.id),
    ['reply-1', 'reply-2'],
  );
});

test('delivery-only duplicates do not leave blank bubbles or inflate thread counts', () => {
  const root = message('root', 'Root message');
  const source = threadRootSource(root, 'session');
  assert.ok(source);
  const visibleReply = message('visible-reply', 'Visible reply', threadMessageAction(source));
  const blankThreadDuplicate = {
    ...message('blank-thread-duplicate', '', threadMessageAction(source)),
    statusChips: ['sent'],
  };
  const blankMainDuplicate = {
    ...message('blank-main-duplicate', ''),
    statusChips: ['sent'],
  };

  const projection = projectMessageThreads([
    root,
    visibleReply,
    blankThreadDuplicate,
    blankMainDuplicate,
  ]);

  assert.deepEqual(projection.mainMessages.map((item) => item.id), ['root']);
  assert.equal(projection.mainMessages[0].threadSummary?.replyCount, 1);
  assert.deepEqual(
    projection.threads.get('root')?.replies.map((item) => item.id),
    ['visible-reply'],
  );
});

test('an agent response inherits the location of its trigger message', () => {
  const root = message('root', 'Root message');
  const source = threadRootSource(root, 'session');
  assert.ok(source);
  const threadTrigger = message('thread-trigger', '@MyKordi help', threadMessageAction(source));
  const threadResponse: Message = {
    ...message('thread-response', ''),
    role: 'owned-agent',
    sender: 'My Kordi',
    senderType: 'agent',
    turn: {
      id: 'thread-response-turn',
      sessionId: 'session',
      prompt: '@MyKordi help',
      status: 'complete',
      message: 'Complete',
      assistantText: 'Thread answer',
      thinkingText: '',
      tools: [],
      completed: true,
      succeeded: true,
    },
  };
  const mainTrigger = message('main-trigger', '@MyKordi main help');
  const mainResponse: Message = {
    ...threadResponse,
    id: 'main-response',
    turn: { ...threadResponse.turn!, id: 'main-response-turn', prompt: '@MyKordi main help', assistantText: 'Main answer' },
  };

  const located = buildReplyAttribution([
    root,
    threadTrigger,
    threadResponse,
    mainTrigger,
    mainResponse,
  ]).messages;
  const projection = projectMessageThreads(located);

  assert.deepEqual(
    projection.threads.get('root')?.replies.map((item) => item.id),
    ['thread-trigger', 'thread-response'],
  );
  assert.deepEqual(
    projection.mainMessages.map((item) => item.id),
    ['root', 'main-trigger', 'main-response'],
  );
});

test('thread projections preserve optimistic counts and isolate queued replies', () => {
  const root = message('root', 'Root message');
  const counted = messagesWithThreadReplyCounts(
    [{ ...root, threadSummary: { replyCount: 2 } }],
    'session',
    null,
    'session',
    'root',
    3,
  );
  const source = threadRootSource(root, 'session');
  assert.ok(source);
  const action = threadMessageAction(source);
  const queued = projectQueuedThreadMessages([
    { id: 'main', sessionId: 'session', scope: 'chat', text: 'main', time: '12:00', attachments: [] },
    { id: 'thread', sessionId: 'session', scope: 'chat', text: 'thread', time: '12:01', attachments: [], messageAction: action },
  ], 'root');

  assert.equal(counted[0].threadSummary?.replyCount, 3);
  assert.deepEqual(queued.mainMessages.map((item) => item.id), ['main']);
  assert.deepEqual(queued.activeThreadMessages.map((item) => item.id), ['thread']);
});

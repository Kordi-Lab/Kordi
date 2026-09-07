import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import {mergeThreadReads, threadHasUnread} from '../src/features/chat/threadReadState';

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

test('Agent turn roots render the existing discussion entry for owners and other members', () => {
  for (const role of ['owned-agent', 'external-agent'] as const) {
    const root: Message = { ...message('agent-root', ''), role, sender: 'Researcher', senderType: 'agent',
      replyAliasIds: ['cloud-agent-root'],
      turn: { id: 'turn', sessionId: 'session', prompt: '', status: 'complete', message: '',
        assistantText: 'ACK', thinkingText: '', tools: [], completed: true, succeeded: true } };
    const source = { ...threadRootSource(root, 'session')!, sourceMessageId: 'cloud-agent-root' };
    const rows = [root, ...[1, 2, 3].map(index => message(`reply-${index}`, `Discussion ${index}`, threadMessageAction(source)))];
    const projected = projectMessageThreads(rows).mainMessages[0];
    assert.equal(projected.threadSummary?.replyCount, 3);
    const render = (msg: Message) => renderToStaticMarkup(createElement(MessageBubble, {msg, onOpenMessageThread: () => {}}));
    assert.match(render(projected), /aria-label="Open thread with 3 discussed in thread"/);
    assert.doesNotMatch(render({...projected, threadSummary: undefined}), /discussed in thread/);
  }
});

test('thread unread state uses monotonic cloud sequences and excludes the viewers own messages', () => {
  const rootId = '10000000-0000-4000-8000-000000000001';
  const root = {...message('local-root','Root'),reactionTargetMessageId:rootId};
  const thread = {root,replies:[{...message('reply','Reply'),conversationSequence:2}]};
  assert(threadHasUnread(thread,{}));
  const cursor = {root_message_id:rootId,root_client_message_id:'client-root',last_read_sequence:2};
  let reads = mergeThreadReads({},[cursor]);
  assert(!threadHasUnread(thread,reads));
  reads = mergeThreadReads(reads,[{...cursor,last_read_sequence:1}]);
  assert.equal(reads[rootId],2);
  thread.replies.push({...message('own','Own reply'),role:'user',isOwnMessage:true,conversationSequence:3});
  assert(!threadHasUnread(thread,reads));
  thread.replies.push({...message('agent','New result'),role:'owned-agent',senderType:'agent',conversationSequence:4});
  assert(threadHasUnread(thread,reads));
});

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

test('thread publication, incoming references, and queues share the cloud root across viewers', () => {
  const wireId = '10000000-0000-4000-8000-000000000001';
  const root = {...message(`collaboration-message:viewer-one:${wireId}`,'Root'),reactionTargetMessageId:wireId};
  const source = threadRootSource(root,'session')!;
  assert.equal(source.sourceMessageId,wireId);
  const otherViewerSource = {...source,sourceMessageId:`collaboration-message:viewer-two:${wireId}`};
  const projection = projectMessageThreads([root,
    message('first','First',threadMessageAction(source)),
    message('second','Second',threadMessageAction(otherViewerSource)),
  ]);
  assert.equal(projection.mainMessages[0].threadSummary?.replyCount,2);
  assert.equal(projection.primaryIdByAlias.get(wireId),root.id);
  const queued = projectQueuedThreadMessages([
    {id:'queued',sessionId:'session',scope:'chat',text:'Next',time:'',attachments:[],messageAction:threadMessageAction(otherViewerSource)},
  ],wireId,projection.primaryIdByAlias);
  assert.equal(queued.activeThreadMessages.length,1);
  const foreign = {...source,sourceMessageId:'collaboration-message:viewer-two:20000000-0000-4000-8000-000000000002'};
  assert.equal(projectMessageThreads([root,message('foreign','Foreign',threadMessageAction(foreign))]).threads.size,0);
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

test('thread entry tracks actual agent completion without exposing its result in main', () => {
  const root = message('root', 'Run a task');
  const source = threadRootSource(root, 'session')!;
  const pending: Message = {
    ...message('response', '', threadMessageAction(source)), role: 'owned-agent',
    replyToMessageId: 'root',
    turn: { id: 'turn', sessionId: 'runtime', prompt: '', status: 'running', message: '', assistantText: '', thinkingText: '', tools: [], completed: false, succeeded: false },
  };
  assert.equal(projectMessageThreads([root, pending]).mainMessages[0].threadSummary?.agentState, 'running');
  const done: Message = { ...pending, id: 'done', turn: { ...pending.turn!, status: 'succeeded', assistantText: 'THREAD_ONLY_RESULT', completed: true, succeeded: true } };
  const projection = projectMessageThreads([root, done, pending]);
  assert.equal(projection.mainMessages.length, 1);
  assert.equal(projection.mainMessages[0].threadSummary?.agentState, 'done');
  assert.equal(projection.mainMessages[0].text, 'Run a task');
});

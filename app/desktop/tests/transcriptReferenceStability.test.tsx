import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTranscriptReferenceStabilizer,
  preserveConversationTranscriptReferences,
  preserveEquivalentTranscriptMessageReferences,
} from '../src/features/chat/transcriptReferenceStability';
import type { Conversation, Message } from '../src/kordi-app/types';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    role: 'owned-agent',
    sender: 'My Kordi',
    text: 'Hello',
    time: '10:00',
    ...overrides,
  };
}

function conversation(id: string, messages: Message[]): Conversation {
  return {
    id,
    canonicalSessionId: id,
    name: id,
    type: 'owned-agent',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Local'],
    trust: 'Owned',
    directness: 'Agent chat',
    participants: ['Me', 'My Kordi'],
    messages,
  };
}

test('keeps the committed Agent transcript and rows when native or canonical mapping clones equivalent values', () => {
  const previous = [
    message({ id: 'user-1', role: 'user', sender: 'Me', text: 'Hello' }),
    message({ id: 'agent-1', text: 'Hi! How can I help?' }),
  ];
  const cloned = previous.map((item) => structuredClone(item));

  const reconciled = preserveEquivalentTranscriptMessageReferences(previous, cloned);

  assert.equal(reconciled, previous);
  assert.equal(reconciled[0], previous[0]);
  assert.equal(reconciled[1], previous[1]);
});

test('keeps the visible Contact catalog row mounted when full history is prepended', () => {
  const latest = message({ id: 'latest', role: 'external-agent', sender: "Contact's Kordi", text: 'Latest reply', time: '10:05' });
  const previous = [latest];
  const hydrated = [
    message({ id: 'older', role: 'user', sender: 'Me', text: 'Earlier question', time: '10:04' }),
    structuredClone(latest),
  ];

  const reconciled = preserveEquivalentTranscriptMessageReferences(previous, hydrated);

  assert.notEqual(reconciled, hydrated);
  assert.equal(reconciled[0], hydrated[0]);
  assert.equal(reconciled[1], latest);
});

test('does not preserve a row when a real response update arrives under the same stable id', () => {
  const previous = [message({ id: 'agent-1', text: 'Processing', turn: {
    id: 'turn-1',
    sessionId: 'session-a',
    prompt: '',
    status: 'running',
    message: '',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
  } })];
  const completed = [message({ id: 'agent-1', text: 'Complete', turn: {
    id: 'turn-1',
    sessionId: 'session-a',
    prompt: '',
    status: 'succeeded',
    message: '',
    assistantText: 'Complete',
    thinkingText: '',
    tools: [],
    completed: true,
    succeeded: true,
  } })];

  const reconciled = preserveEquivalentTranscriptMessageReferences(previous, completed);

  assert.equal(reconciled, completed);
  assert.notEqual(reconciled[0], previous[0]);
});

test('scopes equivalent fallback rows by session instead of reusing another chat row', () => {
  const firstRow = message({ id: undefined, text: 'Same text' });
  const secondRow = message({ id: undefined, text: 'Same text' });
  const firstPass = preserveConversationTranscriptReferences([
    conversation('session-a', [firstRow]),
    conversation('session-b', [secondRow]),
  ], new Map());
  const nextA = message({ id: undefined, text: 'Same text' });
  const nextB = message({ id: undefined, text: 'Same text' });

  const secondPass = preserveConversationTranscriptReferences([
    conversation('session-a', [nextA]),
    conversation('session-b', [nextB]),
  ], firstPass.cache);

  assert.equal(secondPass.conversations[0].messages[0], firstRow);
  assert.equal(secondPass.conversations[1].messages[0], secondRow);
  assert.notEqual(secondPass.conversations[0].messages[0], secondRow);
});

test('drops removed sessions from the reference cache', () => {
  const initial = preserveConversationTranscriptReferences([
    conversation('session-a', [message({ id: 'a' })]),
    conversation('session-b', [message({ id: 'b' })]),
  ], new Map());

  const next = preserveConversationTranscriptReferences([
    conversation('session-b', [message({ id: 'b' })]),
  ], initial.cache);

  assert.deepEqual([...next.cache.keys()], ['session-b']);
});

test('only uses transcript references from a render that React committed', () => {
  const stabilizer = createTranscriptReferenceStabilizer();
  const committedRow = message({ id: 'committed' });
  const firstRender = stabilizer.prepare([
    conversation('session-a', [committedRow]),
  ]);
  const abandonedRow = structuredClone(committedRow);
  const abandonedRender = stabilizer.prepare([
    conversation('session-a', [abandonedRow]),
  ]);
  assert.equal(abandonedRender.conversations[0].messages[0], abandonedRow);

  stabilizer.commit(firstRender.cache);
  const nextRender = stabilizer.prepare([
    conversation('session-a', [structuredClone(committedRow)]),
  ]);

  assert.equal(nextRender.conversations[0].messages[0], committedRow);
});

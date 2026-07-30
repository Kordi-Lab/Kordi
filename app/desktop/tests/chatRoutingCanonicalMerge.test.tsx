import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldUseCanonicalMessages } from '../src/features/canonical/readModel/conversationMapping';
import { restoredSelfAgentContextMessages } from '../src/features/chat/messageActions/chatMessages';
import { mergeCanonicalHistoryIntoRuntime } from '../src/features/canonical/sessionReadModel';

test('canonical read model keeps existing local transcript when canonical has equal message count', () => {
  const existingMessages = [
    { id: 'local-user', role: 'user' as const, text: 'hello', time: '11:41', isOwnMessage: true },
  ];
  const canonicalMessages = [
    { id: 'canonical-user', role: 'user' as const, text: 'hello', time: '11:41', isOwnMessage: true },
  ];

  assert.equal(shouldUseCanonicalMessages(existingMessages, canonicalMessages), false);
});

test('canonical read model prefers equal-count canonical transcript when it adds fork snapshot markers', () => {
  const existingMessages = [
    { id: 'local-old', role: 'user' as const, text: 'old question', time: '11:41', isOwnMessage: true },
    { id: 'local-new', role: 'user' as const, text: 'new fork input', time: '11:42', isOwnMessage: true },
  ];
  const canonicalMessages = [
    { id: 'canonical-old', role: 'user' as const, text: 'old question', time: '11:41', isOwnMessage: true, isForkSnapshot: true },
    { id: 'canonical-new', role: 'user' as const, text: 'new fork input', time: '11:42', isOwnMessage: true },
  ];

  assert.equal(shouldUseCanonicalMessages(existingMessages, canonicalMessages), true);
});

test('canonical fork snapshot markers enrich matching runtime messages after hydration', () => {
  const runtimeMessages = [
    { id: 'runtime-user', entryId: 'entry:user', role: 'user' as const, text: 'old question', time: '11:41', isOwnMessage: true },
    {
      id: 'runtime-agent',
      entryId: 'entry:agent',
      role: 'owned-agent' as const,
      text: '',
      time: '11:42',
      turn: {
        id: 'turn:runtime-agent',
        sessionId: 'session:fork',
        prompt: '',
        status: 'complete' as const,
        message: 'Complete',
        assistantText: 'old answer',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
  ];
  const canonicalMessages = [
    { id: 'msg:canonical-user', role: 'user' as const, text: 'old question', time: '11:41', isOwnMessage: true, isForkSnapshot: true },
    {
      id: 'msg:canonical-agent',
      role: 'owned-agent' as const,
      text: '',
      time: '11:42',
      isForkSnapshot: true,
      turn: {
        id: 'turn:canonical-agent',
        sessionId: 'session:fork',
        prompt: '',
        status: 'complete' as const,
        message: 'Complete',
        assistantText: 'old answer',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
  ];

  const merged = mergeCanonicalHistoryIntoRuntime(canonicalMessages, runtimeMessages);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.isForkSnapshot, true);
  assert.equal(merged[1]?.isForkSnapshot, true);
  assert.deepEqual(merged[1]?.replyAliasIds, ['msg:canonical-agent']);
});

test('restored Cloud self-agent messages are sent as native context for continued local turns', () => {
  const contextMessages = restoredSelfAgentContextMessages([
    {
      id: 'msg:cloud:self:user-1',
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      text: 'What is the weather in Thuwal, Saudi Arabia today?',
      time: '14:30',
      isOwnMessage: true,
    },
    {
      id: 'msg:cloud:self:agent-1',
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '14:31',
      turn: {
        id: 'turn-1',
        sessionId: 'session:restored',
        prompt: 'What is the weather in Thuwal, Saudi Arabia today?',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: 'Thuwal is cloudy today.',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
    {
      id: 'msg:cloud:self:legacy-forward',
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      text: '@MyKordi this copied mention is display-only',
      time: '14:32',
      isOwnMessage: true,
      messageAction: {
        schemaVersion: 1,
        kind: 'forward',
        source: {
          sourceSessionId: 'session:source',
          sourceMessageId: 'msg:source',
          senderLabel: 'Me',
          textPreview: '@MyKordi this copied mention is display-only',
          attachmentCount: 0,
        },
      },
    },
    {
      id: 'msg:ui:local-new',
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      text: 'Can you see the chat history here?',
      time: '14:33',
      isOwnMessage: true,
    },
  ]);

  assert.deepEqual(contextMessages, [
    {
      id: 'msg:cloud:self:user-1',
      authorName: 'Me',
      authorKind: 'human',
      text: 'What is the weather in Thuwal, Saudi Arabia today?',
      createdAtMs: null,
    },
    {
      id: 'msg:cloud:self:agent-1',
      authorName: 'My Kordi',
      authorKind: 'agent',
      text: 'Thuwal is cloudy today.',
      createdAtMs: null,
    },
  ]);
});

test('canonical self-agent fork snapshots are sent as native context for the first local turn', () => {
  const contextMessages = restoredSelfAgentContextMessages([
    {
      id: 'msg:fork:user-1',
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      text: 'Review the current implementation',
      time: '16:04',
      isOwnMessage: true,
      isForkSnapshot: true,
    },
    {
      id: 'desktop-message:fork:agent-1',
      entryId: 'entry:runtime-agent-1',
      replyAliasIds: ['msg:fork:agent-1'],
      role: 'owned-agent',
      sender: 'My Kordi',
      senderType: 'agent',
      text: '',
      time: '16:05',
      isForkSnapshot: true,
      turn: {
        id: 'turn:fork:agent-1',
        sessionId: 'session:fork',
        prompt: 'Review the current implementation',
        status: 'succeeded',
        message: 'Response complete',
        assistantText: 'I found one issue in the fork context handoff.',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
        error: null,
      },
    },
    {
      id: 'msg:ordinary-local',
      role: 'user',
      sender: 'Me',
      senderType: 'human',
      text: 'Do not import ordinary visible local history.',
      time: '16:06',
      isOwnMessage: true,
    },
  ]);

  assert.deepEqual(contextMessages, [
    {
      id: 'msg:fork:user-1',
      authorName: 'Me',
      authorKind: 'human',
      text: 'Review the current implementation',
      createdAtMs: null,
    },
    {
      id: 'msg:fork:agent-1',
      authorName: 'My Kordi',
      authorKind: 'agent',
      text: 'I found one issue in the fork context handoff.',
      createdAtMs: null,
    },
  ]);
});

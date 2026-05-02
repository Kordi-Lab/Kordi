import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conversationSessionId, dedupeAdjacentAgentTurns, formatSessionIdSubtitle, hideRawConversationIds, localOwnedAgentSenderLabel, suppressLiveTurnEchoMessages } from '../src/app/viewModels/helpers';
import type { DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

test('hideRawConversationIds keeps friendly names and preserves canonical ids as subtitles', () => {
  const [conversation] = hideRawConversationIds([{
    id: 'bridge:host:peer:person',
    canonicalSessionId: 'session:bridge:humans:01cdf04168888ea08ffd7069',
    name: 'Bob',
    type: 'person',
    subtitle: 'Direct human chat',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [{
      role: 'user',
      text: 'Please keep this message out of the row title.',
      time: '23:34',
    }],
  }]);

  assert.equal(
    conversation.name,
    'Bob',
    'canonical bridge human ids must not replace user-facing conversation names',
  );
  assert.equal(
    conversation.subtitle,
    'session:bridge:humans:01cdf04168888ea08ffd7069',
    'canonical session id should remain available for subtitle/debug display',
  );
});

test('hideRawConversationIds replaces raw names with stable friendly fallbacks', () => {
  const [rawNamedConversation, draftConversation] = hideRawConversationIds([{
    id: 'session:bridge:humans:01cdf04168888ea08ffd7069',
    canonicalSessionId: 'session:bridge:humans:01cdf04168888ea08ffd7069',
    name: 'session:bridge:humans:01cdf04168888ea08ffd7069',
    type: 'person',
    subtitle: 'Direct human chat',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Alice'],
    messages: [{
      role: 'user',
      text: 'Hi shu. Please check this issue after that.',
      time: '23:34',
    }],
  }, {
    id: 'draft:local-chat',
    canonicalSessionId: undefined,
    name: 'draft:local-chat',
    type: 'owned-agent',
    subtitle: 'Draft',
    unread: 0,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'Kordi'],
    messages: [{
      role: 'system',
      text: 'Session ready',
      time: '23:34',
    }, {
      role: 'user',
      text: 'This is a very long first sentence that should be clipped before it overwhelms the chat header and session rail. More detail follows.',
      time: '23:35',
    }],
  }]);

  assert.equal(
    rawNamedConversation.name,
    'Hi shu.',
    'raw canonical bridge ids should use the first sentence of the first user message',
  );
  assert.equal(
    conversationSessionId(rawNamedConversation),
    'session:bridge:humans:01cdf04168888ea08ffd7069',
    'canonical session id should remain available to callers',
  );
  assert.equal(
    draftConversation.name,
    'This is a very long first sentence that should be clipped before it overwhelms the chat header and session rail.',
    'derived titles should keep the full first sentence so CSS can adapt truncation to available width',
  );
});

test('resolves the live local agent sender from canonical participant scope', () => {
  assert.equal(localOwnedAgentSenderLabel({
    canonicalParticipants: [{
      id: 'agent:local:1',
      name: 'My Kordi',
      kind: 'agent',
      role: 'delegate',
      source: 'local',
      ownerIdentityId: 'human:profile:1',
      ownerName: 'You',
    }],
    participants: ['Me', 'Kordi'],
    messages: [],
  }), 'My Kordi');
});

test('defaults the live local agent sender to My Kordi instead of bare Kordi', () => {
  assert.equal(localOwnedAgentSenderLabel({
    participants: ['Me', 'Kordi'],
    messages: [],
  }), 'My Kordi');
});

test('formatSessionIdSubtitle labels raw ids for display', () => {
  assert.equal(
    formatSessionIdSubtitle('63138d66-0f5b-40dd-90ea-605f7cdb9ba0'),
    'Session ID: 63138d66-0f5b-40dd-90ea-605f7cdb9ba0',
  );
  assert.equal(formatSessionIdSubtitle('  '), '');
  assert.equal(formatSessionIdSubtitle('Direct human chat'), 'Direct human chat');
  assert.equal(
    formatSessionIdSubtitle('session:bridge:bridge:bridge_18e6ee0dbc0d4785a3454a64129fe23b:kd_4FiDc8WETK5o26Ece6XvHFm6b8g9'),
    'Session ID: session:bridge:bridge:bridge_18e6ee0dbc0d4785a3454a64129fe23b:kd_4FiDc8WETK5o26Ece6XvHFm6b8g9',
  );
  assert.equal(
    formatSessionIdSubtitle('session:bridge:humans:c49e4abc'),
    'Session ID: session:bridge:humans:c49e4abc',
  );
  assert.equal(
    formatSessionIdSubtitle('session:group:437f306a-6278-4b64-a635-79a71d2cb3e0'),
    'Session ID: session:group:437f306a-6278-4b64-a635-79a71d2cb3e0',
  );
  assert.equal(formatSessionIdSubtitle('session:direct-agent:next-id'), 'Session ID: session:direct-agent:next-id');
});

function turn(overrides: Partial<DesktopChatTurnSnapshot> = {}): DesktopChatTurnSnapshot {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: 'check issue',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Using the requested-skills workflow first, then I will inspect the repo context.',
    thinkingText: 'Reasoning trace',
    tools: [{
      id: 'tool-1',
      name: 'grep',
      status: 'done',
      arguments: '{"pattern":"issue"}',
      liveOutput: '',
      resultText: 'matched issue context',
      detail: '23ms',
      isError: false,
    }],
    completed: true,
    succeeded: true,
    error: null,
    ...overrides,
  };
}

function agentMessage(sender: string, messageTurn: DesktopChatTurnSnapshot): Message {
  return {
    role: 'owned-agent',
    sender,
    senderType: 'agent',
    text: '',
    time: '12:36',
    turn: messageTurn,
  };
}

test('dedupes adjacent duplicate local agent turns even when sender aliases differ', () => {
  const first = agentMessage('My Kordi', turn());
  const second = agentMessage('Kordi', turn({ id: 'turn-2' }));

  const deduped = dedupeAdjacentAgentTurns([first, second]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0], second);
});

test('drops local tool-only alias turn when next local alias turn contains the final answer', () => {
  const toolOnly = agentMessage('My Kordi', turn({ id: 'turn-tool-only', assistantText: '' }));
  const finalAnswer = agentMessage('Kordi', turn({ id: 'turn-final' }));

  const deduped = dedupeAdjacentAgentTurns([toolOnly, finalAnswer]);

  assert.deepEqual(deduped, [finalAnswer]);
});

test('drops local intro fragment when the following final local turn extends it', () => {
  const intro = agentMessage('Kordi', turn({
    id: 'turn-intro',
    assistantText: 'I’ll check current web sources for today’s weather in Thuwal.',
    thinkingText: '**Checking weather in Thuwal**',
    tools: [],
  }));
  const finalAnswer = agentMessage('My Kordi', turn({
    id: 'turn-final-weather',
    assistantText: 'I’ll check current web sources for today’s weather in Thuwal.\n\nToday’s weather in **Thuwal, Saudi Arabia**:',
    thinkingText: '**Checking weather in Thuwal**',
  }));

  const deduped = dedupeAdjacentAgentTurns([intro, finalAnswer]);

  assert.deepEqual(deduped, [finalAnswer]);
});

test('suppresses all local owned-agent runtime fragments after the triggering user while live turn is rendered', () => {
  const olderAssistant = agentMessage('My Kordi', turn({ id: 'older-turn', assistantText: 'Older completed answer' }));
  const user: Message = {
    role: 'user',
    text: 'check todays thuwal weather',
    time: '16:04',
  };
  const thinkingFragment = agentMessage('Kordi', turn({
    id: 'raw-fragment-1',
    completed: true,
    assistantText: 'I’ll check current web sources for today’s weather in Thuwal.',
    thinkingText: '**Checking weather in Thuwal**',
  }));
  const toolFragment = agentMessage('Kordi', turn({
    id: 'raw-fragment-2',
    completed: true,
    assistantText: 'I’ll check current web sources for today’s weather in Thuwal.Today’s weather in **Thuwal, Saudi Arabia**:',
    tools: [{
      id: 'tool-web-fetch',
      name: 'web_fetch',
      status: 'done',
      arguments: '{}',
      liveOutput: '',
      resultText: 'weather result',
      detail: null,
      isError: false,
    }],
  }));
  const liveTurn = turn({
    id: 'live-turn-weather',
    status: 'running',
    message: 'Running',
    completed: false,
    assistantText: 'I’ll check current web sources for today’s weather in Thuwal.',
    thinkingText: '**Checking weather in Thuwal**',
  });

  assert.deepEqual(
    suppressLiveTurnEchoMessages([olderAssistant, user, thinkingFragment, toolFragment], liveTurn),
    [olderAssistant, user],
  );
});

test('suppresses canonical owned-agent echo while an equivalent live turn is rendered', () => {
  const user: Message = {
    role: 'user',
    text: 'check my diskusage again',
    time: '15:37',
  };
  const canonicalEcho = agentMessage('My Kordi', turn({
    id: 'canonical-turn-1',
    status: 'complete',
    message: 'Complete',
    completed: true,
    assistantText: 'I’ll check overall filesystem usage and the largest items in your home directory.',
    thinkingText: '**Checking disk usage**',
  }));
  const liveTurn = turn({
    id: 'live-turn-1',
    status: 'running',
    message: 'Running',
    completed: false,
    assistantText: 'I’ll check overall filesystem usage and the largest items in your home directory.',
    thinkingText: '**Checking disk usage**',
  });

  assert.deepEqual(suppressLiveTurnEchoMessages([user, canonicalEcho], liveTurn), [user]);
});

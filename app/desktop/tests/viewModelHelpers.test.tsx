import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conversationSessionId, hideRawConversationIds } from '../src/app/viewModels/helpers';

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
    'This is a very long first sentence that should be clipped before it…',
    'long first sentence titles should be truncated with an ellipsis',
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hideRawConversationIds } from '../src/app/viewModels/helpers';

test('friendly conversation names never expose canonical ids as subtitles', () => {
  const [conversation] = hideRawConversationIds([{
    id: 'bridge:host:peer:person',
    canonicalSessionId: 'session:bridge:humans:01cdf04168888ea08ffd7069',
    name: 'Bob',
    type: 'person',
    subtitle: 'Direct human chat',
    unread: 0,
    collaborationSources: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [{ role: 'user', text: 'Please keep this message out of the row title.', time: '23:34' }],
  }]);

  assert.equal(conversation.name, 'Bob');
  assert.equal(conversation.subtitle, 'Direct human chat');
});

test('synthetic Cloud transport ids are removed from subtitles', () => {
  const [conversation] = hideRawConversationIds([{
    id: 'session:self-agent:abc',
    canonicalSessionId: 'session:self-agent:abc',
    name: 'New chat',
    type: 'owned-agent',
    subtitle: 'cloud:conversation:acct_me:agent:session:session%3Aself-agent%3Aabc',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Owned',
    directness: 'Agent chat',
    participants: ['Me', 'My Kordi'],
    messages: [],
  }]);

  assert.equal(conversation.subtitle, '');
});

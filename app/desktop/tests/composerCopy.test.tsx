import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { chatComposerPlaceholder } from '../src/features/chat/composerCopy';
import type { Conversation } from '../src/kordi-app/types';

const chatComposerFiles = [
  '../src/pages/ChatsPage.tsx',
  '../src/features/chat/useComposerInputActions.ts',
  '../src/features/chat/useComposerMessageActions.ts',
  '../src/features/chat/messageActions/chatMessages.ts',
];

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'session:1',
    name: 'Chat',
    type: 'person',
    subtitle: '',
    unread: 0,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'Shu'],
    messages: [],
    ...overrides,
  };
}

test('chat composer placeholder matches contact/group versus agent chat context', () => {
  for (const relativePath of chatComposerFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Message a person, an agent, or delegate a task…/, relativePath);
  }

  assert.equal(chatComposerPlaceholder(conversation({ type: 'person', directness: 'Direct chat' })), 'Send your message, use @ to mention…');
  assert.equal(chatComposerPlaceholder(conversation({ type: 'person', directness: 'Group chat' })), 'Send your message, use @ to mention…');
  assert.equal(chatComposerPlaceholder(conversation({ type: 'group' as Conversation['type'], directness: 'Group chat' })), 'Send your message, use @ to mention…');
  assert.equal(chatComposerPlaceholder(conversation({ type: 'owned-agent', directness: 'Group chat' })), 'Send your message, use @ to mention…');
  assert.equal(chatComposerPlaceholder(conversation({ type: 'owned-agent' })), 'Ask your agent…');
  assert.equal(chatComposerPlaceholder(conversation({ type: 'external-agent' })), 'Ask your agent…');
});

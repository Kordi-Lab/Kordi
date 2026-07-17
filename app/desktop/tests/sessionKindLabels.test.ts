import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_KIND_LABELS,
  chatKindDescriptionLabel,
  conversationChatKindLabel,
  sessionIdChatKindLabel,
} from '../src/features/chat/sessionKindLabels';

test('canonical session ids map to distinct user-facing chat kinds', () => {
  assert.equal(sessionIdChatKindLabel('session:self-agent:one'), CHAT_KIND_LABELS.agent);
  assert.equal(sessionIdChatKindLabel('session:direct-agent:one'), CHAT_KIND_LABELS.agent);
  assert.equal(sessionIdChatKindLabel('session:direct-person:one'), CHAT_KIND_LABELS.person);
  assert.equal(sessionIdChatKindLabel('session:bridge:humans:one'), CHAT_KIND_LABELS.person);
  assert.equal(sessionIdChatKindLabel('session:group:one'), CHAT_KIND_LABELS.group);
  assert.equal(sessionIdChatKindLabel('session:project:one'), CHAT_KIND_LABELS.project);
  assert.equal(sessionIdChatKindLabel('session:fork:one'), CHAT_KIND_LABELS.fork);
  assert.equal(sessionIdChatKindLabel('draft:local-chat'), CHAT_KIND_LABELS.draft);
});

test('legacy local UUID sessions are identified as agent chats', () => {
  assert.equal(
    sessionIdChatKindLabel('63138d66-0f5b-40dd-90ea-605f7cdb9ba0'),
    CHAT_KIND_LABELS.agent,
  );
});

test('conversation labels use canonical kind first and conversation type second', () => {
  assert.equal(conversationChatKindLabel({
    id: 'local-agent',
    type: 'owned-agent',
    directness: 'Direct chat',
  }), CHAT_KIND_LABELS.agent);
  assert.equal(conversationChatKindLabel({
    id: 'person',
    type: 'person',
    directness: 'Direct chat',
  }), CHAT_KIND_LABELS.person);
  assert.equal(conversationChatKindLabel({
    id: 'draft:local-chat',
    type: 'person',
  }), CHAT_KIND_LABELS.draft);
  assert.equal(conversationChatKindLabel({
    id: 'conv',
    canonicalSessionId: 'session:direct-agent:one',
    type: 'person',
  }), CHAT_KIND_LABELS.agent);
});

test('legacy descriptions normalize without presenting ambiguous direct-chat copy', () => {
  assert.equal(chatKindDescriptionLabel('Direct person chat'), CHAT_KIND_LABELS.person);
  assert.equal(chatKindDescriptionLabel('Direct human chat'), CHAT_KIND_LABELS.person);
  assert.equal(chatKindDescriptionLabel('Direct chat'), CHAT_KIND_LABELS.unknown);
});

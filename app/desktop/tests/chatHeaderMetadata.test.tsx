import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { chatHeaderSubtitle, isGenericChatHeaderSubtitle } from '../src/pages/ChatsPage';

test('chat header subtitle hides generic session-kind labels derived from internal ids', () => {
  assert.equal(isGenericChatHeaderSubtitle('Group'), true);
  assert.equal(isGenericChatHeaderSubtitle('Group chat'), true);
  assert.equal(isGenericChatHeaderSubtitle('Direct chat'), true);
  assert.equal(isGenericChatHeaderSubtitle('Direct person chat'), true);
  assert.equal(isGenericChatHeaderSubtitle('Agent chat'), true);
  assert.equal(isGenericChatHeaderSubtitle('Bridge'), true);
  assert.equal(isGenericChatHeaderSubtitle('Cloud'), true);
});

test('chat header subtitle keeps useful user-facing temporary status copy', () => {
  assert.equal(isGenericChatHeaderSubtitle('Cloud direct chat is opening…'), false);
  assert.equal(isGenericChatHeaderSubtitle('Waiting for first message'), false);
});

test('chat header subtitle removes internal group/direct session labels but keeps useful text', () => {
  assert.equal(chatHeaderSubtitle({ subtitle: 'session:group:437f306a-6278-4b64-a635-79a71d2cb3e0' }), null);
  assert.equal(chatHeaderSubtitle({ subtitle: 'session:direct-person:acct_a:acct_b' }), null);
  assert.equal(chatHeaderSubtitle({ subtitle: 'session:direct-agent:next-id' }), null);
  assert.equal(chatHeaderSubtitle({ subtitle: 'Cloud direct chat is opening…' }), 'Cloud direct chat is opening…');
});

test('ChatsPage header does not render trust, bridge, or directness metadata chips', () => {
  const source = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<Shield[\s\S]*activeConv\.trust/);
  assert.doesNotMatch(source, /activeConv\.collaborationSources\.map/);
  assert.doesNotMatch(source, /<Globe[\s\S]*bridge/);
  assert.doesNotMatch(source, /<ArrowRightLeft[\s\S]*activeConv\.directness/);
  assert.doesNotMatch(source, /shouldShowConversationTypeBadge\(activeConv\)/);
});

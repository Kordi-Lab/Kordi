import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldShowConversationTypeBadge } from '../src/pages/ChatsPage';

test('chat header hides the My agent badge for canonical group sessions', () => {
  assert.equal(shouldShowConversationTypeBadge({
    id: 'session:group:342f31b1-534d-4f3b-b4bd-855072767854',
    canonicalSessionId: 'session:group:342f31b1-534d-4f3b-b4bd-855072767854',
    type: 'owned-agent',
  }), false);
});

test('chat header keeps the My agent badge for true self-agent sessions', () => {
  assert.equal(shouldShowConversationTypeBadge({
    id: '4367e286-afb4-4941-b0cb-7d644b0f6ce6',
    canonicalSessionId: '4367e286-afb4-4941-b0cb-7d644b0f6ce6',
    type: 'owned-agent',
  }), true);
});

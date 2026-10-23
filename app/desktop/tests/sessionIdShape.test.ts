import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSessionIdSubtitle } from '../src/app/viewModels/helpers';
import { looksLikeSessionId } from '../src/features/chat/sessionIdShape';

test('formatSessionIdSubtitle labels opaque ids and keeps status text', () => {
  assert.equal(formatSessionIdSubtitle('memtest-group-5df0c05448fe'), 'Chat');
  assert.equal(formatSessionIdSubtitle('acct_0123456789abcdef0123456789abcdef'), 'Chat');
  assert.equal(formatSessionIdSubtitle('Cloud direct chat is opening…'), 'Cloud direct chat is opening…');
  assert.equal(formatSessionIdSubtitle('Back at 5 pm'), 'Back at 5 pm');
});

test('looksLikeSessionId recognises id shapes and rejects free text', () => {
  assert.equal(looksLikeSessionId('session:group:x'), true);
  assert.equal(looksLikeSessionId('63138d66-0f5b-40dd-90ea-605f7cdb9ba0'), true);
  assert.equal(looksLikeSessionId('memtest-group-5df0c05448fe'), true);
  assert.equal(looksLikeSessionId('acct_0123456789abcdef0123456789abcdef'), true);
  assert.equal(looksLikeSessionId('Cloud direct chat is opening…'), false);
  assert.equal(looksLikeSessionId('Back at 5 pm'), false);
  assert.equal(looksLikeSessionId('Bob'), false);
  assert.equal(looksLikeSessionId(''), false);
});

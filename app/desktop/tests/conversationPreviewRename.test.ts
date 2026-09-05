import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildConversationPreview } from '../src/app/viewModels/helpers';
import type { Message } from '../src/kordi-app/types';

test('buildConversationPreview uses a visible rename notice', () => {
  const messages: Message[] = [
    { role: 'user', text: 'Earlier message', time: '09:30' },
    {
      role: 'system',
      text: 'Alex changed the channel name to Planning',
      time: '09:41',
      messageKind: 'session-title-update',
    },
  ];

  assert.equal(buildConversationPreview(messages), 'Alex changed the channel name to Planning');
});

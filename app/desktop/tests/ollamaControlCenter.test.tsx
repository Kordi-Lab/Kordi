import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ollamaPageEndAction } from '../src/kordi-app/auth/OllamaModelControlCenter';

test('ollamaPageEndAction offers Save & enter chat for a running model', () => {
  const action = ollamaPageEndAction({
    activeRunningModelId: 'llama3.2:latest',
    canEnterChat: true,
  });

  assert.equal(action?.id, 'save-enter-chat');
  assert.equal(action?.label, 'Save & enter chat');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lmStudioPageEndAction, lmStudioRuntimeActions } from '../src/kordi-app/auth/LmStudioModelControlCenter';

test('lmStudioRuntimeActions keeps chat entry out of the middle runtime controls', () => {
  const actions = lmStudioRuntimeActions({
    activeRunningModelId: 'google/gemma-4-e4b',
    serverRunning: true,
    isSavingConnection: false,
    activeAction: null,
    canEnterChat: true,
  });

  assert.deepEqual(actions.map((action) => action.id), ['refresh', 'stop-model', 'stop-server']);
});

test('lmStudioPageEndAction offers Save & enter chat for a running model', () => {
  const action = lmStudioPageEndAction({
    activeRunningModelId: 'google/gemma-4-e4b',
    canEnterChat: true,
  });

  assert.equal(action?.id, 'save-enter-chat');
  assert.equal(action?.label, 'Save & enter chat');
});

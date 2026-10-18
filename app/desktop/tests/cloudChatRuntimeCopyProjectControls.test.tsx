import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canChooseChatProject } from '../src/features/projects/chatProjects';
import { cloudChatId, desktopState, localChatId, refreshes, selectedFor } from './helpers/cloudChatRuntimeCopyFixtures';

test('a cloud chat keeps the same project controls while the runtime loads and drops its copy', () => {
  const answers = refreshes.map((activeSessionId, index) => {
    const selected = selectedFor(cloudChatId, desktopState(activeSessionId));
    assert.equal(selected.canonicalSessionId ?? selected.id, cloudChatId, `refresh ${index}: selected chat`);
    return canChooseChatProject(selected);
  });
  assert.deepEqual(answers, refreshes.map(() => false));
});

test('a saved local chat keeps its project controls whichever session the runtime has active', () => {
  const answers = refreshes.map((activeSessionId) => canChooseChatProject(selectedFor(localChatId, desktopState(activeSessionId))));
  assert.deepEqual(answers, refreshes.map(() => true));
});

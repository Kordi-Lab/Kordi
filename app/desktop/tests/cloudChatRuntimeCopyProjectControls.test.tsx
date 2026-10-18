import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canChooseChatProject, isCloudAgentChat } from '../src/features/projects/chatProjects';
import { cloudChatId, desktopState, localChatId, refreshes, selectedFor } from './helpers/cloudChatRuntimeCopyFixtures';

function rowsFor(sessionId: string) {
  return refreshes.map((activeSessionId, index) => {
    const selected = selectedFor(sessionId, desktopState(activeSessionId));
    assert.equal(selected.canonicalSessionId ?? selected.id, sessionId, `refresh ${index}: selected chat`);
    return canChooseChatProject(selected) ? 'enabled' : isCloudAgentChat(selected) ? 'cloud' : 'none';
  });
}

test('a cloud chat keeps a grayed workspace row while the runtime loads and drops its copy', () => {
  assert.deepEqual(rowsFor(cloudChatId), refreshes.map(() => 'cloud'));
});

test('a saved local chat keeps its enabled workspace row whichever session the runtime has active', () => {
  assert.deepEqual(rowsFor(localChatId), refreshes.map(() => 'enabled'));
});

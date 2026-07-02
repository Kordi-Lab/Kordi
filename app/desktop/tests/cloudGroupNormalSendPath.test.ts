import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const chatMessagesSource = () => readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');

test('plain cloud group messages send through cloud group transport instead of falling through to unavailable', () => {
  const source = chatMessagesSource();
  const mentionBranch = source.indexOf('if (activeConversationUsesBridgeRouting && shouldRouteMentionThroughCloudGroup({');
  const unavailableBranch = source.indexOf("if (activeConversationUsesBridgeRouting && !localAgentMentioned)", mentionBranch);
  assert.notEqual(mentionBranch, -1, 'expected cloud group mention branch');
  assert.notEqual(unavailableBranch, -1, 'expected unavailable bridge-routing fallback branch');

  const between = source.slice(mentionBranch, unavailableBranch);
  assert.match(
    between,
    /activeGroupSessionIsGroup[\s\S]*cloudGroupTargetIds\.length > 0[\s\S]*kind:\s*'group-message'/,
    'plain cloud group messages with resolved cloud recipients must be sent as group-message controls before unavailable fallback',
  );
});

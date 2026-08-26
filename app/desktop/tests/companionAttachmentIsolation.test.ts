import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('main and side-panel composers keep attachment drafts isolated', () => {
  const workspace = source('../src/pages/chatsPage.companionWorkspace.tsx');
  const companionSession = source('../src/pages/useChatCompanionSession.ts');
  const actions = source('../src/features/chat/messageActions/chatMessages.ts');
  const targetedStart = actions.indexOf('const sendTargetedChatMessage = useCallback');
  const activeStart = actions.indexOf('const handleSendChatMessage = useCallback', targetedStart);
  const targetedSend = actions.slice(targetedStart, activeStart);

  assert.match(workspace, /useState<ChatAttachment\[\]>\(\[\]\)/);
  assert.match(workspace, /chatComposerAttachments: companionAttachments/);
  assert.doesNotMatch(workspace, /chatComposerAttachments: composer\.chatComposerAttachments/);
  assert.match(companionSession, /onSendChatMessage\([\s\S]*attachments,/);
  assert.doesNotMatch(targetedSend, /chatComposerAttachments|setChatComposerAttachments/);
  assert.match(targetedSend, /preserveComposer: true/);
});

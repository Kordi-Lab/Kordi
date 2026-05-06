import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatComposerFiles = [
  '../src/pages/ChatsPage.tsx',
  '../src/features/chat/useComposerInputActions.ts',
  '../src/features/chat/useComposerMessageActions.ts',
  '../src/features/chat/messageActions/chatMessages.ts',
];

test('chat composer placeholder asks the user to ask their agent', () => {
  for (const relativePath of chatComposerFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Message a person, an agent, or delegate a task…/, relativePath);
  }

  const chatsPage = readFileSync(new URL('../src/pages/ChatsPage.tsx', import.meta.url), 'utf8');
  assert.match(chatsPage, /placeholder="Ask your agent…"/);
});

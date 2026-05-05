import test from 'node:test';
import assert from 'node:assert/strict';

import type { Message, SessionArtifact } from '../src/kordi-app/types';
import { extractSessionArtifacts } from '../src/features/chat/artifacts';

test('session lesson artifacts stay pinned before generated artifacts', () => {
  const messages: Message[] = [{
    role: 'owned-agent',
    sender: 'My Kordi',
    text: 'Updated a file',
    time: '12:00',
    turn: {
      id: 'turn-1',
      sessionId: 'session-123',
      prompt: 'write file',
      status: 'complete',
      message: '',
      assistantText: '',
      thinkingText: '',
      tools: [{
        id: 'tool-1',
        name: 'write',
        status: 'done',
        arguments: JSON.stringify({ path: 'src/generated.ts' }),
        liveOutput: '',
        resultText: 'wrote file',
        detail: null,
        isError: false,
      }],
      completed: true,
      succeeded: true,
    },
  }];
  const lessonArtifact: SessionArtifact = {
    id: 'lesson:conversation:session-123',
    path: '/tmp/kordi/artifacts/reflection-lessons/conversation/session-123.md',
    name: 'Session lessons',
    kind: 'document',
    summary: 'Pinned scoped reflection lesson artifact',
    timeLabel: 'Pinned',
    pinned: true,
  };

  const artifacts = extractSessionArtifacts(messages, null, [lessonArtifact]);

  assert.equal(artifacts[0].id, lessonArtifact.id);
  assert.equal(artifacts[0].pinned, true);
  assert.equal(artifacts[1].path, 'src/generated.ts');
});

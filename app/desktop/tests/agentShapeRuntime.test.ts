import assert from 'node:assert/strict';
import test from 'node:test';

import { draftShapeAgentWithRunner } from '../src/kordi-app/agents/shapeAgentRuntime';

test('draftShapeAgentWithRunner returns LLM draft when model emits valid JSON', async () => {
  const result = await draftShapeAgentWithRunner({
    resources: [{ kind: 'url', value: 'https://docs.example.com' }],
    identity: 'technical support docs helper',
    runPrompt: async () => ({
      succeeded: true,
      assistantText: JSON.stringify({
        name: 'Docs Helper',
        role: 'Technical support agent',
        description: 'Helps with docs',
        systemPrompt: 'Use docs only.',
        sourceSummary: 'Docs site',
        boundaries: ['Be honest'],
        skills: [{ name: 'navigate-knowledge', description: 'Search docs' }],
      }),
    }),
  });

  assert.equal(result.source, 'llm');
  assert.equal(result.draft.name, 'Docs Helper');
});

test('draftShapeAgentWithRunner falls back when model output is malformed', async () => {
  const result = await draftShapeAgentWithRunner({
    resources: [{ kind: 'text', value: 'support docs' }],
    identity: 'technical support docs helper',
    runPrompt: async () => ({ succeeded: true, assistantText: 'not json' }),
  });

  assert.equal(result.source, 'fallback');
  assert.equal(result.draft.name, 'Technical Support Helper');
  assert.match(result.error ?? '', /valid Cloud Agent JSON/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { draftShapeAgentWithRunner } from '../src/kordi-app/agents/shapeAgentRuntime';

test('draftShapeAgentWithRunner returns LLM draft when model emits valid JSON using configured Kordi route', async () => {
  let receivedRoute: unknown = null;
  const result = await draftShapeAgentWithRunner({
    resources: [{ kind: 'url', value: 'https://docs.example.com' }],
    identity: 'technical support docs helper',
    creatorAgent: {
      name: 'Kordi',
      role: 'My agent',
      systemPrompt: 'You are an expert coding assistant.',
      loadedTools: ['read', 'bash'],
      loadedSkills: ['brainstorming'],
      identityFiles: ['AGENTS.md'],
    },
    route: {
      defaultModel: 'openai/gpt-5.5',
      defaultAuthProvider: 'openai',
      defaultAuthChoice: 'api-key',
      thinking: 'medium',
    },
    runPrompt: async (_prompt, route) => {
      receivedRoute = route;
      return {
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
      };
    },
  });

  assert.equal(result.source, 'llm');
  assert.equal(result.draft.name, 'Docs Helper');
  assert.deepEqual(receivedRoute, {
    defaultModel: 'openai/gpt-5.5',
    defaultAuthProvider: 'openai',
    defaultAuthChoice: 'api-key',
    thinking: 'medium',
  });
});

test('draftShapeAgentWithRunner blocks shaping when Kordi has no configured LLM provider', async () => {
  await assert.rejects(
    () => draftShapeAgentWithRunner({
      resources: [{ kind: 'text', value: 'support docs' }],
      identity: 'technical support docs helper',
      creatorAgent: null,
      route: null,
      runPrompt: async () => ({ succeeded: true, assistantText: '{}' }),
    }),
    /Configure Kordi's LLM provider/,
  );
});

test('draftShapeAgentWithRunner falls back when model output is malformed', async () => {
  const result = await draftShapeAgentWithRunner({
    resources: [{ kind: 'text', value: 'support docs' }],
    identity: 'technical support docs helper',
    creatorAgent: {
      name: 'Kordi',
      role: 'My agent',
      systemPrompt: 'You are an expert coding assistant.',
      loadedTools: ['read', 'bash'],
      loadedSkills: ['brainstorming'],
      identityFiles: ['AGENTS.md'],
    },
    route: { defaultModel: 'openai/gpt-5.5', defaultAuthProvider: 'openai', defaultAuthChoice: 'api-key' },
    runPrompt: async () => ({ succeeded: true, assistantText: 'not json' }),
  });

  assert.equal(result.source, 'fallback');
  assert.equal(result.draft.name, 'Technical Support Helper');
  assert.match(result.error ?? '', /valid Cloud Agent JSON/);
});

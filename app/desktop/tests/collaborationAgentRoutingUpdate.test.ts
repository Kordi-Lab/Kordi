import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCollaborationAgentRoutingUpdate } from '../src/features/collaboration/agentModelRouting';

test('route updates preserve omitted collaboration routing fields', () => {
  const update = resolveCollaborationAgentRoutingUpdate({
    defaultModel: 'openai/gpt-5.4',
    defaultAuthProvider: 'openai-codex',
    defaultAuthChoice: 'profile:chatgpt',
    fallbackModel: 'anthropic/claude-sonnet-4-5',
    fallbackAuthProvider: 'anthropic',
    fallbackAuthChoice: 'profile:claude',
    thinking: 'medium',
  }, {
    defaultModel: 'openai/gpt-5.5',
    thinking: 'high',
  });

  assert.deepEqual(update, {
    routing: {
      defaultModel: 'openai/gpt-5.5',
      defaultAuthProvider: 'openai-codex',
      defaultAuthChoice: 'profile:chatgpt',
      fallbackModel: 'anthropic/claude-sonnet-4-5',
      fallbackAuthProvider: 'anthropic',
      fallbackAuthChoice: 'profile:claude',
      thinking: 'high',
    },
    defaultAuthChanged: false,
    fallbackAuthChanged: false,
  });
});

test('route updates report explicit collaboration auth changes only', () => {
  const update = resolveCollaborationAgentRoutingUpdate({
    defaultAuthProvider: 'openai',
    defaultAuthChoice: 'key:old',
    fallbackAuthProvider: null,
    fallbackAuthChoice: null,
  }, {
    defaultAuthChoice: 'key:new',
    fallbackAuthProvider: 'anthropic',
    fallbackAuthChoice: null,
  });

  assert.equal(update.defaultAuthChanged, true);
  assert.equal(update.fallbackAuthChanged, true);
  assert.equal(update.routing.defaultAuthProvider, 'openai');
  assert.equal(update.routing.defaultAuthChoice, 'key:new');
  assert.equal(update.routing.fallbackAuthProvider, 'anthropic');
  assert.equal(update.routing.fallbackAuthChoice, null);
});

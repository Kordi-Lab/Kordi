import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatComposerSelectionForRoute } from '../src/app/useCloudAgentRuntimeRouteSync';
import type { ComposerSelectionState } from '../src/features/chat/composerController.types';

const oldSelection: ComposerSelectionState = {
  chat: { mode: 'agent', model: 'openai/gpt-5.6-sol', thinking: 'medium' },
  project: { mode: 'agent', model: 'ollama/llama3', thinking: 'off' },
};
const hostedDefault = {
  model: 'openai-codex/gpt-5.5',
  authProvider: 'openai-codex',
  authChoice: 'cloud-login:saved',
  thinking: 'high',
};

test('a new hosted chat displays the valid default route model and settles without a selection loop', () => {
  const updated = chatComposerSelectionForRoute(oldSelection, null, hostedDefault);
  assert.equal(updated.chat.model, 'openai-codex/gpt-5.5');
  assert.equal(updated.chat.thinking, 'high');
  assert.equal(updated.project, oldSelection.project);
  assert.equal(chatComposerSelectionForRoute(updated, null, hostedDefault), updated);
});

test('an explicit session route wins and a local default does not rewrite the composer', () => {
  const explicit = { ...hostedDefault, model: 'openai-codex/gpt-5.6-sol', thinking: 'low' };
  assert.equal(chatComposerSelectionForRoute(oldSelection, explicit, hostedDefault).chat.model, explicit.model);
  const localDefault = { model: 'openai/gpt-5.6-sol', authProvider: 'openai', authChoice: 'local-active-api-key' };
  assert.equal(chatComposerSelectionForRoute(oldSelection, null, localDefault), oldSelection);
});

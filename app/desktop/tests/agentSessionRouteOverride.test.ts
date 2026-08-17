import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collaborationAgentWithSessionRoute,
  type LocalCollaborationAgentRoutingOption,
} from '../src/features/collaboration/agentModelRouting';

test('session route overrides stale cloud agent model and thinking for composer display', () => {
  const agent: LocalCollaborationAgentRoutingOption = {
    id: 'agent-1',
    label: 'My Kordi',
    runtime: 'local',
    isDefault: true,
    isActive: true,
    registered: true,
    defaultModel: 'openai/gpt-5.4',
    defaultAuthProvider: 'openai-codex',
    defaultAuthChoice: 'local-active-oauth',
    thinking: 'high',
    hostId: 'host-1',
    hostLabel: 'This Mac',
  };
  const routed = collaborationAgentWithSessionRoute(agent, {
    model: 'openai/gpt-5.6-luna',
    thinking: 'max',
  });
  assert.equal(routed?.defaultModel, 'openai/gpt-5.6-luna');
  assert.equal(routed?.thinking, 'max');
  assert.equal(routed?.defaultAuthProvider, 'openai-codex');
});

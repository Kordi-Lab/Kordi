import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CloudAgentsClient } from '../src/features/cloud/cloudAgentsClient';
import { cloudAgentDefinitionToAgent, normalizeCloudAgentDefinition } from '../src/features/cloud/cloudAgents';
import { factoryAgentCreateInput } from '../src/kordi-app/agents/factoryAgentUtils';
import {
  agentStudioConfigChanges,
  buildAgentStudioDraft,
  buildPersistedAgentConfig,
  cloudAgentProactiveDescription,
  cloudAgentProactiveLabel,
  parsePersistedAgentConfig,
} from '../src/kordi-app/agents/model';

const rawAgent = {
  agentId: 'cloud_agent_abc',
  ownerAccountId: 'acct_owner',
  accessScope: 'private',
  status: 'active',
  name: 'Docs Helper',
  role: 'Technical Support Agent',
  systemPrompt: 'Use docs only.',
  modelRouting: {},
  createdAt: '2026-06-18T00:00:00Z',
  updatedAt: '2026-06-18T00:01:00Z',
  avatar: {
    entityType: 'agent', entityId: 'cloud_agent_abc', source: 'generated', style: 'thumbs', seed: 'seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0', uploadedAsset: null, version: 1, updatedAt: '2026-06-18T00:01:00Z',
  },
};

test('Cooperative defaults to off when the server omits it or sends junk', () => {
  assert.deepEqual(normalizeCloudAgentDefinition(rawAgent)?.proactive, { enabled: false });
  for (const junk of [null, 'on', 1, [], { enabled: 'true' }, { enabled: 1 }]) {
    assert.deepEqual(normalizeCloudAgentDefinition({ ...rawAgent, proactive: junk })?.proactive, { enabled: false });
  }
  assert.deepEqual(normalizeCloudAgentDefinition({ ...rawAgent, proactive: { enabled: true, extra: 1 } })?.proactive, { enabled: true });
});

test('proactive round-trips into the Agent model and the Studio draft', () => {
  const definition = normalizeCloudAgentDefinition({ ...rawAgent, proactive: { enabled: true } });
  assert.ok(definition);
  const agent = cloudAgentDefinitionToAgent(definition);
  assert.deepEqual(agent.cloudAgentProactive, { enabled: true });
  assert.deepEqual(buildAgentStudioDraft(agent).proactive, { enabled: true });
  assert.deepEqual(buildPersistedAgentConfig(agent).proactive, { enabled: true });

  const stored = JSON.stringify({ ...buildPersistedAgentConfig(agent), proactive: { enabled: false } });
  assert.deepEqual(parsePersistedAgentConfig(stored, agent).proactive, { enabled: false });
  assert.deepEqual(parsePersistedAgentConfig('{}', agent).proactive, { enabled: true });
});

test('local agents carry no proactive draft', () => {
  const definition = normalizeCloudAgentDefinition(rawAgent)!;
  const local = { ...cloudAgentDefinitionToAgent(definition), cloudAgentId: undefined };
  assert.equal(buildAgentStudioDraft(local).proactive, undefined);
});

test('the change list shows Cooperative updated only when the draft differs', () => {
  const agent = cloudAgentDefinitionToAgent(normalizeCloudAgentDefinition(rawAgent)!);
  const persisted = buildPersistedAgentConfig(agent);
  assert.deepEqual(agentStudioConfigChanges(buildAgentStudioDraft(agent), persisted), []);
  const changes = agentStudioConfigChanges({ ...buildAgentStudioDraft(agent), proactive: { enabled: true } }, persisted);
  assert.deepEqual(changes, [{ key: 'proactive', label: 'Cooperative updated', detail: 'On' }]);
});

test('Cooperative labels and descriptions follow the Blueprint copy', () => {
  assert.equal(cloudAgentProactiveLabel(false), 'Off');
  assert.equal(cloudAgentProactiveLabel(true), 'On');
  assert.equal(cloudAgentProactiveDescription(false), 'Stays out of your groups.');
  assert.equal(cloudAgentProactiveDescription(true), 'Watches the groups you are in and asks you before it helps.');
});

test('publishing sends Cooperative as both proactive and cooperative with the update and the create input', async () => {
  const bodies: unknown[] = [];
  const client = new CloudAgentsClient({
    baseUrl: 'https://cloud.example',
    fetchImpl: async (_url, init = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ agent: { ...rawAgent, proactive: { enabled: true } } }), { status: 200 });
    },
  });
  const updated = await client.updateCloudAgent('token', 'cloud_agent_abc', { proactive: { enabled: true } });
  // A server without #2091 reads only `proactive`; a newer one accepts both while they agree.
  assert.deepEqual((bodies[0] as { cooperative?: unknown }).cooperative, { enabled: true });
  assert.deepEqual((bodies[0] as { proactive?: unknown }).proactive, { enabled: true });
  await client.createCloudAgent('token', { name: 'A', role: 'B', systemPrompt: 'C', proactive: { enabled: false } });
  assert.deepEqual((bodies[1] as { proactive?: unknown }).proactive, { enabled: false });
  assert.deepEqual((bodies[1] as { cooperative?: unknown }).cooperative, { enabled: false });
  await client.updateCloudAgent('token', 'cloud_agent_abc', { name: 'Renamed' });
  assert.equal('proactive' in (bodies[2] as object) || 'cooperative' in (bodies[2] as object), false);
  assert.deepEqual(updated.proactive, { enabled: true });

  const draft = { name: 'A', role: 'B', description: '', systemPrompt: 'C', sourceSummary: '', boundaries: [], skills: [] };
  assert.deepEqual(factoryAgentCreateInput({ draft, accessScope: 'private', proactive: { enabled: true } }).proactive, { enabled: true });
  assert.equal('proactive' in factoryAgentCreateInput({ draft, accessScope: 'private' }), false);

  const source = readFileSync(new URL('../src/kordi-app/agents/AgentsPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /\.\.\.cloudAgentSettingsUpdate\(activeDraftChanges, activeAgentConfig\)/);
  assert.match(source, /!AGENT_SETTING_CHANGE_KEYS\.has\(change\.key\)/);
});

test('the cooperative field wins over the legacy proactive field', () => {
  assert.deepEqual(normalizeCloudAgentDefinition({ ...rawAgent, cooperative: { enabled: true }, proactive: { enabled: false } })?.proactive, { enabled: true });
  assert.deepEqual(normalizeCloudAgentDefinition({ ...rawAgent, cooperative: { enabled: false }, proactive: { enabled: true } })?.proactive, { enabled: false });
  assert.deepEqual(normalizeCloudAgentDefinition({ ...rawAgent, proactive: { enabled: true } })?.proactive, { enabled: true });
});

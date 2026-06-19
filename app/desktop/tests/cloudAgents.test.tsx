import test from 'node:test';
import assert from 'node:assert/strict';

import { CloudAgentsClient } from '../src/features/cloud/cloudAgentsClient';
import {
  applyCloudAgentSyncEvents,
  cloudAgentDefinitionToAgent,
  normalizeCloudAgentDefinition,
} from '../src/features/cloud/cloudAgents';

const rawAgent = {
  agentId: 'cloud_agent_abc',
  ownerAccountId: 'acct_owner',
  accessScope: 'private',
  status: 'active',
  name: 'Docs Helper',
  role: 'Technical Support Agent',
  description: 'Answers docs questions',
  systemPrompt: 'Use docs only.',
  sourceSummary: 'Description-only docs helper',
  boundaries: ['No account access'],
  resources: [{ kind: 'text', value: 'Docs helper', summary: 'Seed description' }],
  skills: [{ name: 'navigate-knowledge', description: 'Find source-backed answers' }],
  modelRouting: { defaultModel: 'openai/gpt-5.1' },
  createdAt: '2026-06-18T00:00:00Z',
  updatedAt: '2026-06-18T00:01:00Z',
  archivedAt: null,
};

test('normalizeCloudAgentDefinition accepts complete private cloud agents', () => {
  const agent = normalizeCloudAgentDefinition(rawAgent);

  assert.equal(agent?.agentId, 'cloud_agent_abc');
  assert.equal(agent?.accessScope, 'private');
  assert.equal(agent?.skills[0]?.name, 'navigate-knowledge');
  assert.equal(agent?.resources[0]?.kind, 'text');
});

test('normalizeCloudAgentDefinition rejects malformed payloads', () => {
  assert.equal(normalizeCloudAgentDefinition({ ...rawAgent, agentId: '' }), null);
  assert.equal(normalizeCloudAgentDefinition({ ...rawAgent, name: '' }), null);
  assert.equal(normalizeCloudAgentDefinition({ ...rawAgent, role: '' }), null);
  assert.equal(normalizeCloudAgentDefinition({ ...rawAgent, systemPrompt: '' }), null);
  assert.equal(normalizeCloudAgentDefinition({ ...rawAgent, accessScope: 'public' }), null);
});

test('cloudAgentDefinitionToAgent maps private cloud definition into Agent page identity', () => {
  const definition = normalizeCloudAgentDefinition(rawAgent);
  assert.ok(definition);

  const agent = cloudAgentDefinitionToAgent(definition);

  assert.equal(agent.id, 'cloud-agent:cloud_agent_abc');
  assert.equal(agent.name, 'Docs Helper');
  assert.equal(agent.status, 'Private');
  assert.equal(agent.messaging, 'Cloud synced');
  assert.equal(agent.systemPrompt, 'Use docs only.');
  assert.deepEqual(agent.loadedSkills, ['navigate-knowledge']);
  assert.equal(agent.isOwned, true);
  assert.equal(agent.exposesIdentityFiles, false);
  assert.equal(agent.cloudAgentId, 'cloud_agent_abc');
  assert.equal(agent.cloudAgentAccessScope, 'private');
  assert.equal(agent.cloudAgentSourceSummary, 'Description-only docs helper');
});

test('cloudAgentDefinitionToAgent preserves runtime-shaping context for private agent chats', () => {
  const definition = normalizeCloudAgentDefinition(rawAgent);
  assert.ok(definition);

  const agent = cloudAgentDefinitionToAgent(definition);

  assert.equal(agent.cloudAgentId, 'cloud_agent_abc');
  assert.equal(agent.cloudAgentSourceSummary, 'Description-only docs helper');
  assert.deepEqual(agent.cloudAgentBoundaries, ['No account access']);
  assert.equal(agent.cloudAgentSkills?.[0]?.description, 'Find source-backed answers');
});

test('applyCloudAgentSyncEvents upserts and archives cloud agent definitions', () => {
  const upserted = applyCloudAgentSyncEvents({}, [{
    eventId: '1',
    eventType: 'agent.definition.upserted',
    peerAccountId: null,
    messageId: null,
    payload: { agent: rawAgent },
    occurredAt: '2026-06-18T00:02:00Z',
  }]);
  assert.equal(upserted.cloud_agent_abc?.name, 'Docs Helper');

  const archived = applyCloudAgentSyncEvents(upserted, [{
    eventId: '2',
    eventType: 'agent.definition.archived',
    peerAccountId: null,
    messageId: null,
    payload: { agent: { ...rawAgent, status: 'archived', archivedAt: '2026-06-18T00:03:00Z' } },
    occurredAt: '2026-06-18T00:03:00Z',
  }]);
  assert.equal(archived.cloud_agent_abc, undefined);
});

test('CloudAgentsClient lists creates updates and archives cloud agents with bearer auth', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/v1/cloud/agents') && init.method === 'GET') {
      return new Response(JSON.stringify({ agents: [rawAgent] }), { status: 200 });
    }
    if (String(url).endsWith('/v1/cloud/agents') && init.method === 'POST') {
      return new Response(JSON.stringify({ agent: rawAgent }), { status: 201 });
    }
    if (String(url).endsWith('/v1/cloud/agents/cloud_agent_abc') && init.method === 'PUT') {
      return new Response(JSON.stringify({ agent: { ...rawAgent, name: 'Docs Helper v2' } }), { status: 200 });
    }
    if (String(url).endsWith('/v1/cloud/agents/cloud_agent_abc') && init.method === 'DELETE') {
      return new Response(JSON.stringify({ agent: { ...rawAgent, status: 'archived' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ errorCode: 'server_error', message: 'unexpected' }), { status: 500 });
  };

  const client = new CloudAgentsClient({ baseUrl: 'https://cloud.example', fetchImpl });
  assert.equal((await client.listCloudAgents('token')).length, 1);
  assert.equal((await client.createCloudAgent('token', rawAgent)).agentId, 'cloud_agent_abc');
  assert.equal((await client.updateCloudAgent('token', 'cloud_agent_abc', { name: 'Docs Helper v2' })).name, 'Docs Helper v2');
  assert.equal((await client.archiveCloudAgent('token', 'cloud_agent_abc')).status, 'archived');

  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal((call.init.headers as Record<string, string>).authorization, 'Bearer token');
  }
});

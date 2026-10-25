import assert from 'node:assert/strict';
import test from 'node:test';

import { cloudAgentDefinitionChanges } from '../src/kordi-app/agents/factoryAgentIdentity';
import { agentBuilderSeedForAgent, factoryModelTestPolicy, factoryPublishStatus } from '../src/kordi-app/agents/factoryAgentUtils';
import type { Agent } from '../src/kordi-app/types';
import type { DesktopAgentBuilderDraft, DesktopAgentBuilderStatus } from '../src/lib/desktop';

const cloudAgent: Agent = {
  id: 'cloud:agent/alpha',
  name: 'Research Agent',
  role: 'Source-backed research',
  messaging: 'Cloud runtime',
  status: 'Active',
  tasks: 0,
  defaultProvider: 'OpenAI',
  defaultModel: 'gpt-test',
  collaborationConfig: 'Cloud',
  contactId: 'research-agent',
  systemPrompt: 'Cite sources.',
  xMd: '',
  identityFiles: [],
  loadedTools: [],
  loadedSkills: [],
  loadedPlugins: [],
  lastActivities: [],
  isOwned: true,
  cloudAgentId: 'agent_alpha',
  cloudAgentDescription: null,
  cloudAgentSourceSummary: null,
};

function seededDraft(agent: Agent): DesktopAgentBuilderDraft {
  return agentBuilderSeedForAgent(agent) as unknown as DesktopAgentBuilderDraft;
}

test('an untouched Cloud Agent draft lists no definition changes', () => {
  assert.deepEqual(cloudAgentDefinitionChanges(cloudAgent, seededDraft(cloudAgent)), []);
  const described = { ...cloudAgent, cloudAgentDescription: 'Finds sources.', cloudAgentBoundaries: ['No legal advice'] };
  assert.deepEqual(cloudAgentDefinitionChanges(described, seededDraft(described)), []);
  const summarized = { ...cloudAgent, cloudAgentSourceSummary: 'Public papers.' };
  assert.deepEqual(cloudAgentDefinitionChanges(summarized, seededDraft(summarized)), []);
});

test('an edited description is still listed', () => {
  const changes = cloudAgentDefinitionChanges(cloudAgent, { ...seededDraft(cloudAgent), description: 'Writes briefs.' });
  assert.deepEqual(changes.map((change) => change.label), ['Agent description updated']);
});

test('definition, access and avatar changes publish a Cloud Agent without the model test', async () => {
  const status = { draftId: 'draft-1', publishReady: false } as DesktopAgentBuilderStatus;
  let tests = 0;
  const testDraft = async () => {
    tests += 1;
    return { ...status, publishReady: true };
  };

  const identityOnly = factoryModelTestPolicy({ creating: false, agent: cloudAgent, draftChanges: [], routingChanged: false });
  assert.deepEqual(identityOnly, { publishWithoutModelTest: false, skipModelTest: true });
  assert.equal(await factoryPublishStatus(identityOnly.skipModelTest, status, testDraft), status);
  assert.equal(tests, 0);

  const promptChange = factoryModelTestPolicy({ creating: false, agent: cloudAgent, draftChanges: [{ key: 'prompt' }], routingChanged: false });
  assert.equal(promptChange.skipModelTest, false);
  await factoryPublishStatus(promptChange.skipModelTest, status, testDraft);
  assert.equal(tests, 1);

  assert.equal(factoryModelTestPolicy({ creating: false, agent: cloudAgent, draftChanges: [], routingChanged: true }).skipModelTest, false);
  assert.equal(factoryModelTestPolicy({ creating: true, agent: cloudAgent, draftChanges: [], routingChanged: false }).skipModelTest, false);

  const defaultAgent = { ...cloudAgent, id: 'cloud-agent:acct_x', cloudAgentId: undefined, isCollaborationDefault: true };
  assert.deepEqual(
    factoryModelTestPolicy({ creating: false, agent: defaultAgent, draftChanges: [{ key: 'prompt' }], routingChanged: true }),
    { publishWithoutModelTest: true, skipModelTest: true },
  );
});

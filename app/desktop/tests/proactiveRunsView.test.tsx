import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import type { ProactiveActivityEntry } from '../src/features/cloud/proactiveOffer';
import { RunsView } from '../src/kordi-app/agents/AgentStudioRunsView';
import type { Agent } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const NOW = Date.parse('2026-10-24T10:00:00Z');
const agent: Agent = {
  id: 'cloud-agent:alpha', name: 'Scout', role: 'Helper', messaging: 'Cloud synced', status: 'Private', tasks: 0,
  defaultProvider: 'OpenAI', defaultModel: 'gpt-test', collaborationConfig: 'Agent', contactId: 'cloud-agent:alpha',
  systemPrompt: 'Help.', xMd: '', identityFiles: [], loadedTools: [], loadedSkills: [], loadedPlugins: [], lastActivities: ['2026-10-24T08:00:00Z'],
  isOwned: true, cloudAgentId: 'alpha', cloudAgentProactive: { enabled: true },
};
const entries: ProactiveActivityEntry[] = [
  { at: '2026-10-24T09:55:00Z', conversationId: 'g1', conversationTitle: 'Launch crew', decision: 'offer', proposalId: 'pro_1', status: 'pending', problem: 'CI cache', runId: null, error: null },
  { at: '2026-10-24T07:00:00Z', conversationId: 'g2', conversationTitle: 'Design review', decision: 'silence', proposalId: null, status: null, problem: null, runId: null, error: null },
  { at: '2026-10-22T10:00:00Z', conversationId: 'g1', conversationTitle: 'Launch crew', decision: 'offer', proposalId: 'pro_0', status: 'done', problem: 'Docs', runId: 'run', error: null },
];

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test('the Runs tab lists proactive activity under the existing runs', async () => {
  const loads: string[] = [];
  await withJsdomRoot(async (mount) => {
    const host = await mount(<RunsView agent={agent} now={NOW} loadProactiveActivity={async (id) => { loads.push(id); return entries; }} />);
    await flush();
    const rows = Array.from(host.querySelectorAll('.app-agent-studio-proactive-activity .app-agent-studio-simple-list > div'))
      .map((row) => row.textContent);
    assert.deepEqual(rows, [
      'Launch crewOffered · Pending5m ago',
      'Design reviewStayed quiet3h ago',
      'Launch crewOffered · Done2d ago',
    ]);
    assert.match(host.textContent ?? '', /2026-10-24T08:00:00Z/);
    assert.ok((host.textContent ?? '').indexOf('Runs') < (host.textContent ?? '').indexOf('Proactive'));
  });
  assert.deepEqual(loads, ['alpha']);
});

test('an enabled agent with no activity shows one line', async () => {
  await withJsdomRoot(async (mount) => {
    const host = await mount(<RunsView agent={agent} now={NOW} loadProactiveActivity={async () => []} />);
    await flush();
    assert.equal(host.querySelector('.app-agent-studio-proactive-activity .app-agent-studio-runtime-note')?.textContent, 'No proactive activity yet.');
  });
});

test('a disabled agent without activity shows no proactive section', async () => {
  await withJsdomRoot(async (mount) => {
    const host = await mount(<RunsView agent={{ ...agent, cloudAgentProactive: { enabled: false } }} now={NOW} loadProactiveActivity={async () => []} />);
    await flush();
    assert.equal(host.querySelector('.app-agent-studio-proactive-activity'), null);
  });
});

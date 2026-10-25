import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { normalizeProactiveActivity, type ProactiveActivityEntry } from '../src/features/cloud/proactiveOffer';
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

test('failed, pending and cancelled evaluations keep their own labels', async () => {
  const more: ProactiveActivityEntry[] = [
    { at: '2026-10-24T09:58:00Z', conversationId: 'g1', conversationTitle: 'Launch crew', decision: 'pending', proposalId: null, status: null, problem: null, runId: null, error: null },
    { at: '2026-10-24T09:50:00Z', conversationId: 'g1', conversationTitle: 'Launch crew', decision: 'failed', proposalId: null, status: null, problem: null, runId: null, error: 'model_unavailable' },
    { at: '2026-10-24T09:40:00Z', conversationId: 'g1', conversationTitle: 'Launch crew', decision: 'failed', proposalId: null, status: null, problem: null, runId: null, error: null },
    { at: '2026-10-24T09:30:00Z', conversationId: 'g2', conversationTitle: 'Design review', decision: 'cancelled', proposalId: null, status: null, problem: null, runId: null, error: null },
  ];
  await withJsdomRoot(async (mount) => {
    const host = await mount(<RunsView agent={agent} now={NOW} loadProactiveActivity={async () => more} />);
    await flush();
    const rows = Array.from(host.querySelectorAll('.app-agent-studio-proactive-activity .app-agent-studio-simple-list > div'));
    assert.deepEqual(rows.map((row) => row.querySelector('small')?.textContent), [
      'Evaluating',
      'Could not evaluate · model_unavailable',
      'Could not evaluate',
      'Cancelled',
    ]);
    assert.deepEqual(rows.map((row) => row.getAttribute('data-proactive-decision')), ['pending', 'failed', 'failed', 'cancelled']);
  });
});

test('activity decisions from the server are kept, unknown ones read as quiet', () => {
  const read = normalizeProactiveActivity({ activity: ['offer', 'silence', 'failed', 'cancelled', 'pending', 'other'].map((decision) => ({ at: '2026-10-24T09:00:00Z', decision })) });
  assert.deepEqual(read.map((entry) => entry.decision), ['offer', 'silence', 'failed', 'cancelled', 'pending', 'silence']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { CloudAgentsClient } from '../src/features/cloud/cloudAgentsClient';
import { cloudAgentDefinitionToAgent, normalizeCloudAgentDefinition } from '../src/features/cloud/cloudAgents';
import { getPersonalAgentSetting, setPersonalAgentSetting } from '../src/features/personalAgent/personalAgentClient';
import { AgentStudioBlueprintView, type AgentProactiveControl } from '../src/kordi-app/agents/AgentStudioBlueprintView';
import { factoryAgentCreateInput } from '../src/kordi-app/agents/factoryAgentUtils';
import {
  AGENT_SETTING_CHANGE_KEYS,
  CREATION_PERSONAL_PROACTIVE_STORAGE_KEY,
  CREATION_PROACTIVE_STORAGE_KEY,
  cloudAgentSettingsUpdate,
  factoryProactiveControl,
  useCreationProactiveDraft,
} from '../src/kordi-app/agents/factoryProactiveDraft';
import {
  AGENT_CONFIG_STORAGE_KEY,
  agentStudioConfigChanges,
  buildAgentStudioDraft,
  buildPersistedAgentConfig,
  parsePersistedAgentConfig,
  personalAgentProactiveDescription,
  readStoredAgentDrafts,
} from '../src/kordi-app/agents/model';
import type { Agent } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const rawAgent = {
  agentId: 'cloud_agent_abc', ownerAccountId: 'acct_owner', accessScope: 'private', status: 'active',
  name: 'Inbox helper', role: 'Mail', systemPrompt: 'Watch the inbox.', modelRouting: {},
  createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:01:00Z',
  avatar: {
    entityType: 'agent', entityId: 'cloud_agent_abc', source: 'generated', style: 'thumbs', seed: 'seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0', uploadedAsset: null, version: 1, updatedAt: '2026-10-25T00:01:00Z',
  },
};
const definitionAgent = (personalAgent?: unknown) => cloudAgentDefinitionToAgent(normalizeCloudAgentDefinition({ ...rawAgent, personalAgent })!);

function view(control: AgentProactiveControl, agent: Agent = definitionAgent()) {
  return (
    <AgentStudioBlueprintView
      agent={agent} creating={false} creationDraft={null}
      config={{ systemPrompt: agent.systemPrompt, loadedSkills: [], loadedTools: [], loadedPlugins: [], proactive: { enabled: control.enabled } }}
      changes={[]} accessScope="private" onAccessScopeChange={() => undefined} proactive={control}
      canEditPrompt={false} onPromptChange={() => undefined} onCreationDraftChange={() => undefined} onOpenCapabilities={() => undefined}
    />
  );
}

function rowText(host: HTMLElement, label: string) {
  const row = Array.from(host.querySelectorAll('.app-agent-studio-blueprint-row'))
    .find((element) => element.querySelector('.app-agent-studio-blueprint-label')?.textContent === label);
  return row ? { value: row.querySelector('.app-agent-studio-blueprint-value')?.textContent, detail: row.querySelector('.app-agent-studio-blueprint-detail')?.textContent } : null;
}

test('the Proactive row sits under Cooperative with its own copy', async () => {
  await withJsdomRoot(async (mount) => {
    const host = await mount(view({ enabled: true, personal: { enabled: false } }));
    const labels = Array.from(host.querySelectorAll('.app-agent-studio-blueprint-label')).map((element) => element.textContent);
    assert.equal(labels.indexOf('Proactive'), labels.indexOf('Cooperative') + 1);
    assert.deepEqual(rowText(host, 'Proactive'), { value: 'Off', detail: 'Waits for you to write first.' });
    await mount(view({ enabled: true, personal: { enabled: true } }));
    assert.deepEqual(rowText(host, 'Proactive'), { value: 'On', detail: 'Reaches out to you in Personal agent.' });
    await mount(view({ enabled: true }));
    assert.equal(rowText(host, 'Proactive'), null);
    assert.ok(rowText(host, 'Cooperative'));
  });
});

test('choosing On in the Proactive menu changes only the Proactive draft', async () => {
  const personal: boolean[] = [];
  const cooperative: boolean[] = [];
  await withJsdomRoot(async (mount) => {
    const host = await mount(view({ enabled: false, onChange: (value) => cooperative.push(value), personal: { enabled: false, onChange: (value) => personal.push(value) } }));
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Edit proactive"]')!.click(); });
    const menu = host.querySelector('[role="menu"][aria-label="Agent proactive"]');
    assert.ok(menu);
    const options = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    assert.deepEqual(options.map((option) => option.querySelector('small')?.textContent), [
      'Waits for you to write first.',
      'Reaches out to you in Personal agent.',
    ]);
    await act(async () => { options[1]!.click(); });
    assert.deepEqual(personal, [true]);
    assert.deepEqual(cooperative, []);
  });
});

test('personalAgent normalizes to off unless the server says proactive true', () => {
  assert.deepEqual(normalizeCloudAgentDefinition(rawAgent)?.personalAgent, { proactive: false });
  for (const junk of [null, 'on', 1, [], { proactive: 'true' }, { enabled: true }]) {
    assert.deepEqual(normalizeCloudAgentDefinition({ ...rawAgent, personalAgent: junk })?.personalAgent, { proactive: false });
  }
  const agent = definitionAgent({ proactive: true });
  assert.deepEqual(agent.cloudAgentPersonalAgent, { proactive: true });
  assert.equal(buildAgentStudioDraft(agent).personalProactive, true);
  assert.equal(buildPersistedAgentConfig(agent).personalProactive, true);
  assert.equal(buildAgentStudioDraft({ ...agent, cloudAgentId: undefined }).personalProactive, undefined);
});

test('the change list shows Proactive updated with its own key', () => {
  const agent = definitionAgent();
  const persisted = buildPersistedAgentConfig(agent);
  assert.deepEqual(agentStudioConfigChanges({ ...buildAgentStudioDraft(agent), personalProactive: true }, persisted), [
    { key: 'personalProactive', label: 'Proactive updated', detail: 'On' },
  ]);
  assert.deepEqual(agentStudioConfigChanges({ ...buildAgentStudioDraft(agent), personalProactive: false }, persisted), []);
  assert.ok(AGENT_SETTING_CHANGE_KEYS.has('personalProactive'));
  assert.ok(AGENT_SETTING_CHANGE_KEYS.has('proactive'));
  assert.equal(AGENT_SETTING_CHANGE_KEYS.has('prompt'), false);
});

test('stored drafts keep only settings edited here; older drafts fall back to the server value', async () => {
  const agent = definitionAgent();
  assert.equal(parsePersistedAgentConfig(JSON.stringify({ personalProactive: true }), agent).personalProactive, true);
  assert.equal(parsePersistedAgentConfig('{}', agent).personalProactive, false);
  await withJsdomRoot(async () => {
    window.localStorage.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify({
      [agent.id]: { systemPrompt: 'Draft', proactive: { enabled: true }, personalProactive: true, editedSettings: ['personalProactive', 'bogus'] },
      older: { systemPrompt: 'Old', proactive: { enabled: true }, personalProactive: false },
    }));
    const drafts = readStoredAgentDrafts();
    assert.equal(drafts[agent.id]?.personalProactive, true);
    assert.equal(drafts[agent.id]?.proactive, undefined);
    assert.deepEqual(drafts[agent.id]?.editedSettings, ['personalProactive']);
    assert.equal(drafts.older?.systemPrompt, 'Old');
    assert.equal(drafts.older?.personalProactive, undefined);
    assert.equal(drafts.older?.proactive, undefined);
  });
});

test('a Factory agent publishes only the changed settings in its update body', async () => {
  const config = { systemPrompt: '', loadedSkills: [], loadedTools: [], loadedPlugins: [], proactive: { enabled: true }, personalProactive: true };
  assert.deepEqual(cloudAgentSettingsUpdate([], config), {});
  assert.deepEqual(cloudAgentSettingsUpdate([{ key: 'personalProactive', label: '', detail: '' }], config), { personalAgent: { proactive: true } });
  assert.deepEqual(cloudAgentSettingsUpdate([{ key: 'proactive', label: '', detail: '' }], config), { proactive: { enabled: true } });

  const bodies: Array<Record<string, unknown>> = [];
  const client = new CloudAgentsClient({
    baseUrl: 'https://cloud.example',
    fetchImpl: async (_url, init = {}) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ agent: { ...rawAgent, cooperative: { enabled: true }, personalAgent: { proactive: true } } }), { status: 200 });
    },
  });
  const updated = await client.updateCloudAgent('token', 'cloud_agent_abc', { ...cloudAgentSettingsUpdate([{ key: 'personalProactive', label: '', detail: '' }, { key: 'proactive', label: '', detail: '' }], config) });
  assert.deepEqual(bodies[0], { proactive: { enabled: true }, cooperative: { enabled: true }, personalAgent: { proactive: true } });
  assert.deepEqual(updated.personalAgent, { proactive: true });
  assert.deepEqual(updated.proactive, { enabled: true });

  const draft = { name: 'A', role: 'B', description: '', systemPrompt: 'C', sourceSummary: '', boundaries: [], skills: [] };
  assert.deepEqual(factoryAgentCreateInput({ draft, accessScope: 'private', personalAgent: { proactive: true } }).personalAgent, { proactive: true });
  assert.equal('personalAgent' in factoryAgentCreateInput({ draft, accessScope: 'private' }), false);
});

test('the Blueprint control carries the Proactive row for Factory agents and new agents', () => {
  const agent = definitionAgent({ proactive: true });
  const calls: Array<[string, boolean]> = [];
  const creation = { enabled: false, setEnabled: () => undefined, personalEnabled: true, setPersonalEnabled: (value: boolean) => calls.push(['creation', value]) };
  const owned = factoryProactiveControl({
    creating: false, creation, agent, config: buildAgentStudioDraft(agent), setProactiveDraft: () => undefined,
    setPersonalProactiveDraft: (id, value) => calls.push([id, value]),
  });
  assert.equal(owned?.personal?.enabled, true);
  owned?.personal?.onChange?.(false);
  const drafted = factoryProactiveControl({
    creating: false, creation, agent, config: { ...buildAgentStudioDraft(agent), personalProactive: false }, setProactiveDraft: () => undefined,
    setPersonalProactiveDraft: () => undefined,
  });
  assert.equal(drafted?.personal?.enabled, false);
  const created = factoryProactiveControl({ creating: true, creation, config: null, setProactiveDraft: () => undefined });
  assert.equal(created?.personal?.enabled, true);
  created?.personal?.onChange?.(false);
  assert.deepEqual(calls, [[agent.id, false], ['creation', false]]);
  assert.equal(personalAgentProactiveDescription(false), 'Waits for you to write first.');
});

test('a new agent keeps its Proactive choice apart from Cooperative', async () => {
  const seen: Array<ReturnType<typeof useCreationProactiveDraft>> = [];
  function Probe({ draftId }: { draftId: string }) {
    const draft = useCreationProactiveDraft(draftId);
    seen.push(draft);
    return <button type="button" onClick={() => draft.setPersonalEnabled(true)}>On</button>;
  }
  await withJsdomRoot(async (mount) => {
    const host = await mount(<Probe draftId="draft-1" />);
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); });
    const latest = seen[seen.length - 1]!;
    assert.equal(latest.personalEnabled, true);
    assert.deepEqual(latest.personalInput, { proactive: true });
    assert.equal(latest.enabled, false);
    assert.equal(latest.input, undefined);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(CREATION_PERSONAL_PROACTIVE_STORAGE_KEY) ?? '{}'), { 'draft-1': true });
    assert.equal(window.localStorage.getItem(CREATION_PROACTIVE_STORAGE_KEY), null);
    await mount(<Probe draftId="draft-2" />);
    assert.equal(seen[seen.length - 1]!.personalEnabled, false);
  });
});

test('the personal agent setting routes encode the default agent id', async () => {
  const calls: Array<[string, string, unknown]> = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push([init.method ?? 'GET', String(url).replace(/^.*\/v1/, '/v1'), init.body ? JSON.parse(String(init.body)) : undefined]);
    return new Response(JSON.stringify({ proactive: init.method === 'PUT' }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await getPersonalAgentSetting('tok', 'cloud-agent:acct_owner'), { proactive: false });
    assert.deepEqual(await setPersonalAgentSetting('tok', 'cloud-agent:acct_owner', true), { proactive: true });
  } finally {
    globalThis.fetch = previous;
  }
  assert.deepEqual(calls, [
    ['GET', '/v1/cloud/agents/cloud-agent%3Aacct_owner/personal-agent', undefined],
    ['PUT', '/v1/cloud/agents/cloud-agent%3Aacct_owner/personal-agent', { proactive: true }],
  ]);
});

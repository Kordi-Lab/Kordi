import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { __setSessionBackendForTests, type StoredSession } from '../src/features/cloud/session';
import { AgentStudioBlueprintView } from '../src/kordi-app/agents/AgentStudioBlueprintView';
import { RunsView } from '../src/kordi-app/agents/AgentStudioRunsView';
import { factoryProactiveControl, publishDefaultAgentSettings, useDefaultAgentProactive, withDefaultAgentProactiveChange, withDefaultAgentSettingChanges } from '../src/kordi-app/agents/factoryProactiveDraft';
import { agentStudioConfigChanges, publishableLocalAgentConfigChanges } from '../src/kordi-app/agents/model';
import { useAgentsPageModel } from '../src/kordi-app/agents/useAgentsPageModel';
import type { Agent } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const DEFAULT_ID = 'cloud-agent:acct_owner';
const ENCODED = 'cloud-agent%3Aacct_owner';
const kordi: Agent = {
  id: 'desktop:local-agent', name: 'Kordi', role: 'Assistant', messaging: 'Local', status: 'Ready', tasks: 0,
  defaultProvider: 'OpenAI', defaultModel: 'gpt-test', collaborationConfig: 'Local', contactId: 'desktop:local-agent',
  systemPrompt: 'Help.', xMd: '', identityFiles: [], loadedTools: [], loadedSkills: [], loadedPlugins: [], lastActivities: [], isOwned: true,
};
const AGENTS = [kordi];
const noCreation = { enabled: false, setEnabled: () => undefined, input: undefined };

function useSession(session: StoredSession | null) {
  __setSessionBackendForTests({ load: async () => session, save: async () => undefined, clear: async () => undefined });
}

type Call = { url: string; method: string; body: unknown };
type ServerState = { value: boolean; personal?: boolean; personalStatus?: number };
function stubFetch(server: ServerState) {
  const calls: Call[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ url: String(url), method, body });
    if (String(url).includes('/personal-agent')) {
      if (server.personalStatus) return new Response(JSON.stringify({ errorCode: 'not_found' }), { status: server.personalStatus });
      if (method === 'PUT') server.personal = (body as { proactive: boolean }).proactive;
      return new Response(JSON.stringify({ proactive: server.personal ?? false }), { status: 200 });
    }
    if (method === 'PUT') server.value = (body as { enabled: boolean }).enabled;
    if (String(url).includes('/decision')) return new Response(JSON.stringify({ proposalId: 'pro_1', status: 'running' }), { status: 200 });
    if (String(url).includes('/activity')) return new Response(JSON.stringify({ activity: [] }), { status: 200 });
    return new Response(JSON.stringify({ enabled: server.value }), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** Mirrors AgentsPage's wiring for the default agent: draft storage, change list, Publish and Discard. */
function Harness({ agent }: { agent: Agent }) {
  const model = useAgentsPageModel(AGENTS, agent);
  const settings = useDefaultAgentProactive(agent, 'acct_owner');
  const config = model.activeAgentConfig!;
  const changes = withDefaultAgentSettingChanges(
    publishableLocalAgentConfigChanges(agentStudioConfigChanges(config, model.activePersistedConfig!), false, false), config, settings,
  );
  const control = factoryProactiveControl({
    creating: false, creation: noCreation, agent, config, setProactiveDraft: model.setProactiveDraft,
    setPersonalProactiveDraft: model.setPersonalProactiveDraft, defaultAgent: settings,
  });
  const publish = async () => {
    await publishDefaultAgentSettings(settings, changes, config);
    model.markAgentDraftPublished(agent, config);
  };
  return (
    <>
      <AgentStudioBlueprintView
        agent={agent} creating={false} creationDraft={null} config={config} changes={changes} accessScope="private"
        onAccessScopeChange={() => undefined} proactive={control} canEditPrompt={false} onPromptChange={() => undefined}
        onCreationDraftChange={() => undefined} onOpenCapabilities={() => undefined}
      />
      <button type="button" data-testid="publish" onClick={() => { void publish(); }}>Publish</button>
      <button type="button" data-testid="discard" onClick={() => model.resetAgentDraft(agent)}>Discard</button>
    </>
  );
}

function rowValue(host: HTMLElement, label: 'Cooperative' | 'Proactive') {
  const row = Array.from(host.querySelectorAll('.app-agent-studio-blueprint-row'))
    .find((element) => element.querySelector('.app-agent-studio-blueprint-label')?.textContent === label);
  return row ? row.querySelector('.app-agent-studio-blueprint-value')?.textContent ?? null : null;
}
function changeText(host: HTMLElement) {
  return host.querySelector('.app-agent-studio-change-list')?.textContent ?? '';
}
async function choose(host: HTMLElement, row: 'cooperative' | 'proactive', label: 'On' | 'Off') {
  await act(async () => { host.querySelector<HTMLButtonElement>(`button[aria-label="Edit ${row}"]`)!.click(); });
  const option = Array.from(host.querySelectorAll<HTMLButtonElement>(`[role="menu"][aria-label="Agent ${row}"] [role="menuitemradio"]`))
    .find((element) => element.textContent?.startsWith(label));
  await act(async () => { option!.click(); });
}
async function click(host: HTMLElement, id: string) {
  await act(async () => { host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(); });
  await flush();
}
function paths(calls: Call[]) {
  return calls.map((call) => [call.method, call.url.replace(/^.*\/v1/, '/v1')]).sort((left, right) => left.join(' ').localeCompare(right.join(' ')));
}

test('the default agent shows both fetched settings when signed in', async () => {
  useSession({ token: 'tok', accountId: 'acct_owner', expiresAt: '2099-01-01T00:00:00Z' });
  const server = stubFetch({ value: true, personal: false });
  try {
    await withJsdomRoot(async (mount) => {
      const host = await mount(<Harness agent={kordi} />);
      await flush();
      assert.equal(rowValue(host, 'Cooperative'), 'On');
      assert.equal(rowValue(host, 'Proactive'), 'Off');
      assert.equal(changeText(host), '');
    });
    assert.deepEqual(paths(server.calls), [
      ['GET', `/v1/cloud/agents/${ENCODED}/personal-agent`],
      ['GET', `/v1/cloud/agents/${ENCODED}/proactive`],
    ]);
  } finally {
    server.restore();
  }
});

test('the default agent has neither row when signed out', async () => {
  useSession(null);
  const server = stubFetch({ value: true });
  try {
    await withJsdomRoot(async (mount) => {
      const host = await mount(<Harness agent={kordi} />);
      await flush();
      assert.equal(rowValue(host, 'Cooperative'), null);
      assert.equal(rowValue(host, 'Proactive'), null);
    });
    assert.equal(server.calls.length, 0);
  } finally {
    server.restore();
  }
});

test('a server without the personal agent route keeps the Cooperative row only', async () => {
  useSession({ token: 'tok', accountId: 'acct_owner', expiresAt: '2099-01-01T00:00:00Z' });
  const server = stubFetch({ value: false, personalStatus: 404 });
  try {
    await withJsdomRoot(async (mount) => {
      const host = await mount(<Harness agent={kordi} />);
      await flush();
      assert.equal(rowValue(host, 'Cooperative'), 'Off');
      assert.equal(rowValue(host, 'Proactive'), null);
    });
  } finally {
    server.restore();
  }
});

test('switching Cooperative is a draft change that Publish sends and Discard restores', async () => {
  useSession({ token: 'tok', accountId: 'acct_owner', expiresAt: '2099-01-01T00:00:00Z' });
  const server = stubFetch({ value: false });
  try {
    await withJsdomRoot(async (mount) => {
      let host = await mount(<Harness key="first" agent={kordi} />);
      await flush();
      assert.equal(rowValue(host, 'Cooperative'), 'Off');
      await choose(host, 'cooperative', 'On');
      assert.equal(rowValue(host, 'Cooperative'), 'On');
      assert.match(changeText(host), /Cooperative updated/);

      host = await mount(<Harness key="reloaded" agent={kordi} />);
      await flush();
      assert.equal(rowValue(host, 'Cooperative'), 'On');
      assert.match(changeText(host), /Cooperative updated/);

      await click(host, 'discard');
      assert.equal(rowValue(host, 'Cooperative'), 'Off');
      assert.equal(changeText(host), '');
      assert.equal(server.calls.filter((call) => call.method === 'PUT').length, 0);

      await click(host, 'publish');
      assert.equal(server.calls.filter((call) => call.method === 'PUT').length, 0);

      await choose(host, 'cooperative', 'On');
      await click(host, 'publish');
      const puts = server.calls.filter((call) => call.method === 'PUT');
      assert.equal(puts.length, 1);
      assert.match(puts[0]!.url, new RegExp(`/v1/cloud/agents/${ENCODED}/proactive$`));
      assert.deepEqual(puts[0]!.body, { enabled: true });
      assert.equal(rowValue(host, 'Cooperative'), 'On');
      assert.equal(changeText(host), '');
    });
  } finally {
    server.restore();
  }
});

test('switching Proactive publishes through the personal agent route only', async () => {
  useSession({ token: 'tok', accountId: 'acct_owner', expiresAt: '2099-01-01T00:00:00Z' });
  const server = stubFetch({ value: false, personal: false });
  try {
    await withJsdomRoot(async (mount) => {
      const host = await mount(<Harness agent={kordi} />);
      await flush();
      await choose(host, 'proactive', 'On');
      assert.equal(rowValue(host, 'Proactive'), 'On');
      assert.equal(rowValue(host, 'Cooperative'), 'Off');
      assert.match(changeText(host), /Proactive updated/);
      assert.doesNotMatch(changeText(host), /Cooperative updated/);

      await click(host, 'publish');
      const puts = server.calls.filter((call) => call.method === 'PUT');
      assert.equal(puts.length, 1);
      assert.match(puts[0]!.url, new RegExp(`/v1/cloud/agents/${ENCODED}/personal-agent$`));
      assert.deepEqual(puts[0]!.body, { proactive: true });
      assert.equal(rowValue(host, 'Proactive'), 'On');
      assert.equal(changeText(host), '');
    });
  } finally {
    server.restore();
  }
});

test('the change list ignores either setting until its server value is known', () => {
  const config = { systemPrompt: '', loadedSkills: [], loadedTools: [], loadedPlugins: [], proactive: { enabled: true }, personalProactive: true };
  const stale = [{ key: 'proactive', label: 'Cooperative updated', detail: 'On' }];
  const personal = { key: 'personalProactive', label: 'Proactive updated', detail: 'On' };
  assert.deepEqual(withDefaultAgentProactiveChange(stale, config, null), []);
  assert.deepEqual(withDefaultAgentProactiveChange([], config, true), []);
  assert.deepEqual(withDefaultAgentProactiveChange([], config, false), stale);
  assert.deepEqual(withDefaultAgentSettingChanges([personal], config, { published: true, personalPublished: null }), []);
  assert.deepEqual(withDefaultAgentSettingChanges([], config, { published: true, personalPublished: true }), []);
  assert.deepEqual(withDefaultAgentSettingChanges([], config, { published: false, personalPublished: false }), [...stale, personal]);
  assert.equal(factoryProactiveControl({ creating: false, creation: noCreation, agent: kordi, config, setProactiveDraft: () => undefined, defaultAgent: { agentId: null, published: null } }), undefined);
  assert.equal(factoryProactiveControl({ creating: false, creation: noCreation, agent: { ...kordi, id: 'local:other', isCollaborationDefault: false }, config, setProactiveDraft: () => undefined, defaultAgent: { agentId: DEFAULT_ID, published: false } }), undefined);
});

test('the Runs tab loads the default agent activity by its server id', async () => {
  const loads: string[] = [];
  await withJsdomRoot(async (mount) => {
    const host = await mount(<RunsView agent={kordi} proactiveActivity={{ agentId: DEFAULT_ID, enabled: true }} loadProactiveActivity={async (id) => { loads.push(id); return []; }} />);
    await flush();
    assert.equal(host.querySelector('.app-agent-studio-proactive-activity .app-agent-studio-runtime-note')?.textContent, 'No activity yet.');
    await mount(<RunsView agent={kordi} loadProactiveActivity={async (id) => { loads.push(id); return []; }} />);
    await flush();
    assert.equal(host.querySelector('.app-agent-studio-proactive-activity'), null);
  });
  assert.deepEqual(loads, [DEFAULT_ID]);
});

test('every proactive client path encodes an agent id with a colon', async () => {
  const client = await import('../src/features/cloud/proactiveClient');
  const server = stubFetch({ value: false });
  try {
    assert.deepEqual(await client.getProactiveSetting('tok', DEFAULT_ID), { enabled: false });
    assert.deepEqual(await client.setProactiveSetting('tok', DEFAULT_ID, true), { enabled: true });
    await client.decideProactiveProposal('tok', DEFAULT_ID, 'pro_1', 'allow');
    await client.listProactiveActivity('tok', DEFAULT_ID, 50);
    assert.deepEqual(server.calls.map((call) => [call.method, call.url.replace(/^.*\/v1/, '/v1')]), [
      ['GET', `/v1/cloud/agents/${ENCODED}/proactive`],
      ['PUT', `/v1/cloud/agents/${ENCODED}/proactive`],
      ['POST', `/v1/cloud/agents/${ENCODED}/proactive/proposals/pro_1/decision`],
      ['GET', `/v1/cloud/agents/${ENCODED}/proactive/activity?limit=50`],
    ]);
    assert.equal(client.defaultAgentProactiveId('acct_owner'), DEFAULT_ID);
  } finally {
    server.restore();
  }
});

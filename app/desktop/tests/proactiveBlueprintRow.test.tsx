import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { AgentStudioBlueprintView } from '../src/kordi-app/agents/AgentStudioBlueprintView';
import type { Agent } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const agent: Agent = {
  id: 'cloud-agent:alpha', name: 'Research Agent', role: 'Research', messaging: 'Cloud synced', status: 'Private', tasks: 0,
  defaultProvider: 'OpenAI', defaultModel: 'gpt-test', collaborationConfig: 'Agent', contactId: 'cloud-agent:alpha',
  systemPrompt: 'Cite sources.', xMd: '', identityFiles: [], loadedTools: [], loadedSkills: [], loadedPlugins: [], lastActivities: [],
  isOwned: true, cloudAgentId: 'alpha', cloudAgentAccessScope: 'private', cloudAgentProactive: { enabled: false },
};

function view(enabled: boolean, onChange?: (enabled: boolean) => void) {
  return (
    <AgentStudioBlueprintView
      agent={agent}
      creating={false}
      creationDraft={null}
      config={{ systemPrompt: agent.systemPrompt, loadedSkills: [], loadedTools: [], loadedPlugins: [], proactive: { enabled } }}
      changes={[]}
      accessScope="private"
      onAccessScopeChange={() => undefined}
      proactive={{ enabled, onChange }}
      canEditPrompt={false}
      onPromptChange={() => undefined}
      onCreationDraftChange={() => undefined}
      onOpenCapabilities={() => undefined}
    />
  );
}

function rowText(host: HTMLElement, label: string) {
  const row = Array.from(host.querySelectorAll('.app-agent-studio-blueprint-row'))
    .find((element) => element.querySelector('.app-agent-studio-blueprint-label')?.textContent === label);
  return {
    value: row?.querySelector('.app-agent-studio-blueprint-value')?.textContent,
    detail: row?.querySelector('.app-agent-studio-blueprint-detail')?.textContent,
  };
}

test('the Proactive row sits under Access and shows Off or On with its description', async () => {
  await withJsdomRoot(async (mount) => {
    const host = await mount(view(false));
    const labels = Array.from(host.querySelectorAll('.app-agent-studio-blueprint-label')).map((element) => element.textContent);
    assert.equal(labels.indexOf('Proactive'), labels.indexOf('Access') + 1);
    assert.deepEqual(rowText(host, 'Proactive'), { value: 'Off', detail: 'Does nothing on its own.' });
    await mount(view(true));
    assert.deepEqual(rowText(host, 'Proactive'), { value: 'On', detail: 'Watches the groups you are in and asks you before it helps.' });
  });
});

test('choosing On in the Proactive menu updates the draft', async () => {
  const changes: boolean[] = [];
  await withJsdomRoot(async (mount) => {
    const host = await mount(view(false, (enabled) => changes.push(enabled)));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Edit proactive"]');
    assert.ok(trigger);
    await act(async () => { trigger.click(); });
    const menu = host.querySelector('[role="menu"][aria-label="Agent proactive"]');
    assert.ok(menu);
    const options = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    assert.deepEqual(options.map((option) => option.querySelector('small')?.textContent), [
      'Does nothing on its own.',
      'Watches the groups you are in and asks you before it helps.',
    ]);
    assert.equal(options[0]?.getAttribute('aria-checked'), 'true');
    await act(async () => { options[1]!.click(); });
    assert.deepEqual(changes, [true]);
    assert.equal(host.querySelector('[role="menu"][aria-label="Agent proactive"]'), null);
  });
});

test('the Proactive row is read-only without a change handler', async () => {
  await withJsdomRoot(async (mount) => {
    const host = await mount(view(false));
    assert.equal(host.querySelector('button[aria-label="Edit proactive"]'), null);
    assert.ok(host.querySelector('button[aria-label="Edit access"]'));
  });
});

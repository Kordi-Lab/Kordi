import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { normalizeAgentAccessScope } from '../src/features/cloud/agentAccessClient';
import { AgentInspectionView } from '../src/kordi-app/agents/AgentInspectionView';
import { AgentStudioBlueprintView } from '../src/kordi-app/agents/AgentStudioBlueprintView';
import { builderAccessScope, builderAccessValue, useDefaultAgentAccess, withPublishedAccess } from '../src/kordi-app/agents/defaultAgentAccess';
import { agentBuilderSeedForAgent } from '../src/kordi-app/agents/factoryAgentUtils';
import { cloudAgentAccessDescription, cloudAgentAccessLabel } from '../src/kordi-app/agents/model';
import type { Agent } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const kordi: Agent = {
  id: 'desktop:local-agent', name: 'Kordi', role: 'Assistant', messaging: 'Local', status: 'Ready', tasks: 0,
  collaborationConfig: 'Local', contactId: 'desktop:local-agent', systemPrompt: 'Help.', xMd: '', identityFiles: [],
  loadedTools: [], loadedSkills: [], loadedPlugins: [], lastActivities: [], isOwned: true,
};
const factory: Agent = { ...kordi, id: 'cloud-agent:cloud_agent_1', contactId: 'cloud-agent:cloud_agent_1', cloudAgentId: 'cloud_agent_1', cloudAgentAccessScope: 'private', name: 'Scout' };

test('a missing Access reads as open, never as Only me', () => {
  assert.equal(cloudAgentAccessLabel(undefined), 'People in my chats can mention it');
  assert.equal(cloudAgentAccessLabel('participant_conversations'), 'People in my chats can mention it');
  assert.equal(cloudAgentAccessLabel('private'), 'Only me');
  assert.equal(cloudAgentAccessDescription(undefined), 'People in your chats can @mention it.');
  assert.equal(cloudAgentAccessDescription('private'), 'Only you can use it.');
  assert.equal(normalizeAgentAccessScope(undefined), 'participant_conversations');
  assert.equal(normalizeAgentAccessScope('private'), 'private');
});

test('new Factory drafts and the default agent start open', () => {
  assert.equal(agentBuilderSeedForAgent(undefined).access, 'participant-conversations');
  assert.equal(agentBuilderSeedForAgent(kordi).access, 'participant-conversations');
  assert.equal(agentBuilderSeedForAgent(factory).access, 'only-me');
  assert.equal(builderAccessScope(undefined), 'participant_conversations');
  assert.equal(builderAccessScope('participant-conversations'), 'participant_conversations');
  assert.equal(builderAccessScope('only-me'), 'private');
  assert.equal(builderAccessValue('private'), 'only-me');
  assert.equal(builderAccessValue('participant_conversations'), 'participant-conversations');
});

test('the default agent carries its stored Access; Factory agents keep theirs', () => {
  assert.equal(withPublishedAccess(kordi, {}, 'private')?.cloudAgentAccessScope, 'private');
  assert.equal(withPublishedAccess(kordi, {}, null)?.cloudAgentAccessScope, undefined);
  assert.equal(withPublishedAccess(factory, {}, 'participant_conversations')?.cloudAgentAccessScope, 'private');
  assert.equal(withPublishedAccess(kordi, { [kordi.id]: 'participant_conversations' }, 'private')?.cloudAgentAccessScope, 'participant_conversations');
  assert.equal(withPublishedAccess(undefined, {}, 'private'), undefined);
});

test('the default agent page shows its real Access', () => {
  const page = (agent: Agent) => renderToStaticMarkup(<AgentInspectionView agent={agent} onEditInBuild={() => undefined} />);
  assert.match(page(kordi), /People in my chats can mention it/);
  assert.doesNotMatch(page(kordi), /Only me/);
  assert.match(page({ ...kordi, cloudAgentAccessScope: 'private' }), /Only me/);
});

test('the Blueprint Access row has the same menu for the default agent', async () => {
  await withJsdomRoot(async (mount) => {
    const chosen: string[] = [];
    const host = await mount(
      <AgentStudioBlueprintView
        agent={kordi} creating={false} creationDraft={null} config={null} changes={[]} accessScope="participant_conversations"
        onAccessScopeChange={(scope) => chosen.push(scope)} canEditPrompt={false} onPromptChange={() => undefined}
        onCreationDraftChange={() => undefined} onOpenCapabilities={() => undefined}
      />,
    );
    const row = Array.from(host.querySelectorAll('.app-agent-studio-blueprint-row'))
      .find((element) => element.querySelector('.app-agent-studio-blueprint-label')?.textContent === 'Access');
    assert.equal(row?.querySelector('.app-agent-studio-blueprint-value')?.textContent, 'People in my chats can mention it');
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Edit access"]')!.click(); });
    const option = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="Agent access"] [role="menuitemradio"]'))
      .find((element) => element.textContent?.startsWith('Only me'));
    await act(async () => { option!.click(); });
    assert.deepEqual(chosen, ['private']);
  });
});

function Probe({ onReady }: { onReady: (value: ReturnType<typeof useDefaultAgentAccess>) => void }) {
  const access = useDefaultAgentAccess('acct_owner');
  onReady(access);
  return <span data-testid="access">{access.published ?? 'unknown'}</span>;
}

test('the default agent Access is read and written under cloud-agent:<account>', async () => {
  __setSessionBackendForTests({
    load: async () => ({ token: 'tok', accountId: 'acct_owner', expiresAt: '2099-01-01T00:00:00Z' }),
    save: async () => undefined,
    clear: async () => undefined,
  });
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let stored = 'private';
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) as { accessScope: string } : undefined;
    calls.push({ method, url: String(url).replace(/^.*\/v1/, '/v1'), body });
    if (body) stored = body.accessScope;
    return new Response(JSON.stringify({ agentId: 'cloud-agent:acct_owner', accessScope: stored }), { status: 200 });
  }) as typeof fetch;
  try {
    await withJsdomRoot(async (mount) => {
      let latest: ReturnType<typeof useDefaultAgentAccess> | null = null;
      const host = await mount(<Probe onReady={(value) => { latest = value; }} />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.equal(host.querySelector('[data-testid="access"]')?.textContent, 'private');
      await act(async () => { await latest!.publish('participant_conversations'); });
      assert.equal(host.querySelector('[data-testid="access"]')?.textContent, 'participant_conversations');
    });
    assert.deepEqual(calls, [
      { method: 'GET', url: '/v1/cloud/agents/cloud-agent%3Aacct_owner/access', body: undefined },
      { method: 'PUT', url: '/v1/cloud/agents/cloud-agent%3Aacct_owner/access', body: { accessScope: 'participant_conversations' } },
    ]);
  } finally {
    globalThis.fetch = previous;
    __setSessionBackendForTests(null);
  }
});

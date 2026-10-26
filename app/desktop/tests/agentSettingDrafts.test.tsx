import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useMemo } from 'react';

import { cloudAgentDefinitionToAgent, normalizeCloudAgentDefinition } from '../src/features/cloud/cloudAgents';
import { AGENT_CONFIG_STORAGE_KEY } from '../src/kordi-app/agents/model';
import { useAgentsPageModel } from '../src/kordi-app/agents/useAgentsPageModel';
import type { Agent } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const rawAgent = {
  agentId: 'cloud_agent_inbox', ownerAccountId: 'acct_alex', accessScope: 'private', status: 'active',
  name: 'Inbox helper', role: 'Inbox', systemPrompt: 'Sort mail.', modelRouting: {},
  createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:01:00Z',
  avatar: {
    entityType: 'agent', entityId: 'cloud_agent_inbox', source: 'generated', style: 'thumbs', seed: 'seed',
    rendererVersion: 'dicebear-rust-10.6.0-styles-10.5.0', uploadedAsset: null, version: 1, updatedAt: '2026-10-25T00:01:00Z',
  },
};
const agentWith = (cooperative: boolean, proactive: boolean) => cloudAgentDefinitionToAgent(normalizeCloudAgentDefinition({
  ...rawAgent, cooperative: { enabled: cooperative }, personalAgent: { proactive },
})!);

type Model = ReturnType<typeof useAgentsPageModel>;

test('Cooperative and Proactive follow the server unless edited here, and a publish never pins them', async () => {
  let model: Model | null = null;
  function Harness({ agent }: { agent: Agent }) {
    const agents = useMemo(() => [agent], [agent]);
    model = useAgentsPageModel(agents, agent);
    return null;
  }
  const settingChanges = () => model!.activeDraftChanges.filter((change) => change.key === 'proactive' || change.key === 'personalProactive').map((change) => change.key);
  const stored = () => JSON.parse(window.localStorage.getItem(AGENT_CONFIG_STORAGE_KEY) ?? '{}') as Record<string, Record<string, unknown>>;
  await withJsdomRoot(async (mount) => {
    const off = agentWith(false, false);
    // A draft stored by an older build pinned both settings without saying they were edited.
    window.localStorage.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify({ [off.id]: { systemPrompt: 'Sort mail.', proactive: { enabled: true }, personalProactive: true } }));
    await mount(<Harness agent={off} />);
    assert.equal(model!.activeAgentConfig?.personalProactive, false);
    assert.deepEqual(model!.activeAgentConfig?.proactive, { enabled: false });
    assert.deepEqual(settingChanges(), []);

    // Editing another field does not copy the server values into the stored draft.
    await act(async () => { model!.updatePrompt(off.id, 'Sort mail daily.'); });
    assert.equal('personalProactive' in stored()[off.id]!, false);

    await act(async () => { model!.setPersonalProactiveDraft(off.id, true); });
    assert.equal(model!.activeAgentConfig?.personalProactive, true);
    assert.deepEqual(settingChanges(), ['personalProactive']);
    assert.deepEqual(stored()[off.id]!.editedSettings, ['personalProactive']);

    // Publishing clears the settings from the stored draft; the refreshed agent carries the value.
    const published = agentWith(false, true);
    await act(async () => { model!.markAgentDraftPublished(off, model!.activeAgentConfig!); });
    await mount(<Harness agent={published} />);
    assert.equal(model!.activeAgentConfig?.personalProactive, true);
    assert.deepEqual(settingChanges(), []);
    assert.equal('personalProactive' in stored()[off.id]!, false);
    assert.equal('editedSettings' in stored()[off.id]!, false);

    // Another Mac turns both settings off and on: this Mac follows and has nothing to send back.
    await mount(<Harness agent={agentWith(true, false)} />);
    assert.equal(model!.activeAgentConfig?.personalProactive, false);
    assert.deepEqual(model!.activeAgentConfig?.proactive, { enabled: true });
    assert.deepEqual(settingChanges(), []);
  });
});

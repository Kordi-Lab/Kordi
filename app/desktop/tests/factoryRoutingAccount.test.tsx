import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { AgentStudioRoutingEditor } from '../src/kordi-app/agents/AgentStudioRoutingEditor';
import type { AgentModelRoutingDraft } from '../src/kordi-app/agents/factoryAgentUtils';
import { factoryDraftModelRouting, factoryDraftWithRouting } from '../src/kordi-app/agents/factoryAgentUtils';
import type { DesktopAgentBuilderDraft } from '../src/lib/desktop';
import { withJsdomRoot } from './helpers/mountWithJsdom';

test('a stale Factory account can be replaced without changing the selected Luna model', async () => {
  await withJsdomRoot(async (mount) => {
    let saved: AgentModelRoutingDraft | undefined;
    const host = await mount(<AgentStudioRoutingEditor
      routing={{ defaultModel: 'openai/gpt-6-luna', defaultAuthProvider: 'openai-codex', defaultAuthChoice: 'cloud-login:old', thinking: 'low' }}
      modelOptions={[{ value: 'openai/gpt-6-luna', label: 'Luna', provider: 'openai', thinkingLevels: ['low'] }]}
      providerOptions={[
        { value: 'openai-codex::cloud-login:new', label: 'Synthetic connected account', providerId: 'openai-codex', active: true },
        { value: 'anthropic::cloud-login:other', label: 'Other provider', providerId: 'anthropic' },
      ]}
      onSave={(route) => { saved = route; }} onClose={() => undefined}
    />);
    const label = Array.from(host.querySelectorAll('label')).find((item) => item.textContent?.startsWith('Provider account'))!;
    const select = label.querySelector('select')!;
    assert.match(label.textContent ?? '', /Account unavailable/);
    assert.doesNotMatch(label.textContent ?? '', /Other provider/);
    await act(async () => {
      select.value = 'cloud-login:new';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await act(async () => { Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Save routing')!.click(); });
    assert.equal(saved?.defaultAuthChoice, 'cloud-login:new');
    assert.equal(saved?.defaultAuthProvider, 'openai-codex');
    assert.equal(saved?.defaultModel, 'openai/gpt-6-luna');
    assert.equal(saved?.thinking, 'low');
    const draft = factoryDraftWithRouting({ name: 'Synthetic' } as DesktopAgentBuilderDraft, saved!);
    assert.deepEqual(factoryDraftModelRouting(draft), {
      defaultModel: saved?.defaultModel, defaultAuthProvider: saved?.defaultAuthProvider,
      defaultAuthChoice: saved?.defaultAuthChoice, thinking: 'low',
    });
  });
});

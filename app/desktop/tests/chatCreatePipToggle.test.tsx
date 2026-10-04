import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { CreateChatGroupRequest } from '../src/app/chatGroupRequest.types';
import type { AgentTrustApi, AgentTrustCalls } from '../src/features/agentTrust/agentTrustApi';
import { enablePipForNewGroup, inheritPipForChannel } from '../src/features/agentTrust/groupPip';
import { clearAiFeaturesCache } from '../src/features/agentTrust/useAiFeatures';
import type { AiAccessChange, ChatSyncAiAccess } from '../src/features/cloud/agentTrustTypes';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';
import { ChatCreateDialog } from '../src/pages/ChatCreateDialog';
import { contact } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

type Call = { sessionId: string; change?: AiAccessChange; read?: boolean };

function fakeApi({
  available = true, sourceAccess = null as ChatSyncAiAccess | null, failUpdate = false,
  returned = undefined as ChatSyncAiAccess | undefined,
} = {}) {
  const calls: Call[] = [];
  const agentTrust = {
    aiFeatures: async () => ({ pip: { available, providerLabel: available ? 'OpenAI' : null } }),
    aiAccess: async (_token: string, sessionId: string) => { calls.push({ sessionId, read: true }); return sourceAccess; },
    updateAiAccess: async (_token: string, sessionId: string, change: AiAccessChange) => {
      calls.push({ sessionId, change });
      if (failUpdate) throw new Error('offline');
      return { id: 'c', legacy_session_id: sessionId, ai_access: returned } as unknown as ChatSyncConversation;
    },
  } as unknown as AgentTrustCalls;
  const api: AgentTrustApi = { session: async () => ({ token: `token-${available}`, accountId: 'acct_me' }), calls: agentTrust };
  return { api, calls };
}

async function renderGroupForm(api: AgentTrustApi, onCreateGroup: (request: CreateChatGroupRequest) => void) {
  clearAiFeaturesCache();
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ChatCreateDialog, {
      isOpen: true,
      contacts: [contact({ id: 'contact:alice', name: 'Alice' }), contact({ id: 'contact:bo', name: 'Bo' })],
      agents: [],
      onClose: () => undefined,
      onStartPerson: () => undefined,
      onStartAgent: () => undefined,
      onCreateGroup,
      initialMode: 'group',
      agentTrustApi: api,
    }));
  });
  await flushReactUpdates();
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, 'element exists');
    await act(async () => { (element as HTMLElement).click(); });
    await flushReactUpdates();
  };
  return {
    host,
    pipSwitch: () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Add PiP, the plan helper"]'),
    async pickTwoAndSubmit() {
      for (const name of ['Alice', 'Bo']) {
        await click([...host.querySelectorAll('button')].find((button) => button.textContent?.includes(name)));
      }
      await click([...host.querySelectorAll('button[type="submit"]')].find((button) => button.textContent === 'Create group'));
    },
    click,
    async close() { await act(async () => root.unmount()); installed.restore(); clearAiFeaturesCache(); },
  };
}

test('the PiP switch is hidden when the server has no PiP', async () => {
  const { api } = fakeApi({ available: false });
  const requests: CreateChatGroupRequest[] = [];
  const view = await renderGroupForm(api, (request) => { requests.push(request); });
  try {
    assert.equal(view.pipSwitch(), null);
    await view.pickTwoAndSubmit();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.pipEnabled, undefined);
  } finally {
    await view.close();
  }
});

test('PiP is off by default and the creator can turn it on', async () => {
  const { api } = fakeApi();
  const requests: CreateChatGroupRequest[] = [];
  let view = await renderGroupForm(api, (request) => { requests.push(request); });
  try {
    const pip = view.pipSwitch();
    assert.ok(pip, 'switch is shown');
    assert.equal(pip.getAttribute('aria-checked'), 'false');
    const help = document.getElementById(pip.getAttribute('aria-describedby') ?? '');
    assert.match(help?.textContent ?? '', /using OpenAI through Kordi's account\. You can change this later in AI access\./);
    await view.pickTwoAndSubmit();
    assert.equal(requests[0]?.pipEnabled, undefined, 'off unless asked');
  } finally {
    await view.close();
  }
  view = await renderGroupForm(api, (request) => { requests.push(request); });
  try {
    await view.click(view.pipSwitch());
    assert.equal(view.pipSwitch()?.getAttribute('aria-checked'), 'true');
    await view.pickTwoAndSubmit();
    assert.equal(requests[1]?.pipEnabled, true);
    assert.deepEqual(requests[1]?.contactIds.length, 2);
  } finally {
    await view.close();
  }
});

test('after creation PiP is turned on with one change, and a failure keeps the group', async () => {
  const ok = fakeApi();
  const errors: string[] = [];
  assert.equal(await enablePipForNewGroup('session:group:new', (message) => errors.push(message), ok.api), true);
  assert.deepEqual(ok.calls, [{ sessionId: 'session:group:new', change: { pip_enabled: true } }]);
  assert.deepEqual(errors, []);
  const failing = fakeApi({ failUpdate: true });
  assert.equal(await enablePipForNewGroup('session:group:new', (message) => errors.push(message), failing.api), false);
  assert.deepEqual(errors, ['The group was created, but PiP couldn\'t be turned on. You can turn it on in AI access.']);
});

test('the setting saved but PiP could not join: the creator is told, and a channel reports it', async () => {
  const pipOff: ChatSyncAiAccess = {
    history_scope: 'mentions', pip: { available: true, enabled: false, provider_label: 'OpenAI' },
    excluded_member_ids: [], viewer_excluded: false, viewer_can_manage: true,
  };
  const notJoined = fakeApi({ returned: pipOff });
  const errors: string[] = [];
  assert.equal(await enablePipForNewGroup('session:group:new', (message) => errors.push(message), notJoined.api), false);
  assert.deepEqual(errors, ['The group was created, but PiP couldn\'t be turned on. You can turn it on in AI access.']);
  // Positive control: a snapshot that shows PiP on is a success.
  const joined = fakeApi({ returned: { ...pipOff, pip: { available: true, enabled: true, provider_label: 'OpenAI' } } });
  assert.equal(await enablePipForNewGroup('session:group:new', (message) => errors.push(message), joined.api), true);
  assert.equal(errors.length, 1);
  const failures: unknown[] = [];
  const channel = fakeApi({ returned: pipOff, sourceAccess: { ...pipOff, pip: { available: true, enabled: true, provider_label: null } } });
  assert.equal(
    await inheritPipForChannel('session:group:root', 'session:group:channel', channel.api, (error) => failures.push(error)),
    false,
  );
  assert.equal(failures.length, 1);
});

test('new channels inherit PiP only from a channel that has it', async () => {
  const withPip = fakeApi({ sourceAccess: {
    history_scope: 'mentions', pip: { available: true, enabled: true, provider_label: 'OpenAI' },
    excluded_member_ids: [], viewer_excluded: false, viewer_can_manage: true,
  } });
  assert.equal(await inheritPipForChannel('session:group:root', 'session:group:channel', withPip.api), true);
  assert.deepEqual(withPip.calls, [
    { sessionId: 'session:group:root', read: true },
    { sessionId: 'session:group:channel', change: { pip_enabled: true } },
  ]);
  const withoutPip = fakeApi({ sourceAccess: null });
  assert.equal(await inheritPipForChannel('session:group:root', 'session:group:channel', withoutPip.api), false);
  assert.deepEqual(withoutPip.calls, [{ sessionId: 'session:group:root', read: true }]);
  const failures: unknown[] = [];
  const failing = fakeApi({ failUpdate: true, sourceAccess: {
    history_scope: 'mentions', pip: { available: true, enabled: true, provider_label: null },
    excluded_member_ids: [], viewer_excluded: false, viewer_can_manage: false,
  } });
  assert.equal(
    await inheritPipForChannel('session:group:root', 'session:group:channel', failing.api, (error) => failures.push(error)),
    false,
  );
  assert.equal(failures.length, 1, 'a failure is reported to the caller, never thrown');
  assert.equal(await inheritPipForChannel('session:group:root', 'session:group:channel', failing.api), false, 'silent by default');
  assert.equal(await inheritPipForChannel(null, 'session:group:channel', withPip.api), false);
  assert.equal(await inheritPipForChannel('session:group:channel', 'session:group:channel', withPip.api), false, 'never from itself');
});

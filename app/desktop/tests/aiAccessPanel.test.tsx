import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { aiAccessMemberNames, turnedOnByText } from '../src/features/agentTrust/aiAccessCopy';
import { AI_ACCESS_UPDATED_EVENT, dispatchWindowEvent } from '../src/features/agentTrust/agentTrustEvents';
import type { AgentTrustApi, AgentTrustCalls } from '../src/features/agentTrust/agentTrustApi';
import type { AiAccessChange, ChatSyncAiAccess } from '../src/features/cloud/agentTrustTypes';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { AiAccessPanel } from '../src/kordi-app/components/aiAccessPanel';
import type { ConversationParticipant } from '../src/kordi-app/types';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

const SESSION = 'session:group:weekend';

function access(overrides: Partial<ChatSyncAiAccess> = {}): ChatSyncAiAccess {
  return {
    history_scope: 'mentions',
    pip: { available: true, enabled: false, provider_label: 'OpenAI' },
    excluded_member_ids: ['acct_c'],
    viewer_excluded: false,
    viewer_can_manage: true,
    ...overrides,
  };
}

function fakeApi(initial: ChatSyncAiAccess, update?: (change: AiAccessChange) => Promise<ChatSyncAiAccess>) {
  const changes: AiAccessChange[] = [];
  let current = initial;
  let reads = 0;
  const calls = {
    aiAccess: async (_token: string, sessionId: string) => {
      assert.equal(sessionId, SESSION);
      reads += 1;
      return current;
    },
    updateAiAccess: async (_token: string, sessionId: string, change: AiAccessChange) => {
      assert.equal(sessionId, SESSION);
      changes.push(change);
      current = update ? await update(change) : current;
      return { id: 'c1', legacy_session_id: SESSION, ai_access: current } as unknown as ChatSyncConversation;
    },
  } as unknown as AgentTrustCalls;
  const api: AgentTrustApi = { session: async () => ({ token: 'token', accountId: 'acct_me' }), calls };
  return { api, changes, reads: () => reads };
}

const names = new Map([['acct_c', 'Casey'], ['acct_me', 'You']]);

async function render(api: AgentTrustApi, mode: 'group' | 'direct' = 'group') {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(AiAccessPanel, { sessionId: SESSION, mode, memberNames: names, currentAccountId: 'acct_me', api }));
  });
  await flushReactUpdates();
  return {
    host,
    switchNamed: (name: string) => host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`),
    radio: (value: string) => host.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`),
    async click(element: Element | null) {
      assert.ok(element, 'element exists');
      await act(async () => { (element as HTMLElement).click(); });
      await flushReactUpdates();
    },
    async close() { await act(async () => root.unmount()); installed.restore(); },
  };
}

test('managers see editable controls with accessible names and help', async () => {
  const { api } = fakeApi(access());
  const view = await render(api);
  try {
    const text = view.host.textContent ?? '';
    assert.match(text, /AI access/);
    assert.match(text, /What agents can see/);
    assert.match(text, /It can't read the rest of this conversation\./);
    assert.match(text, /Turned on byCasey/);
    assert.match(text, /It uses OpenAI through Kordi's account\./);
    assert.match(text, /it works in a workspace kept separate for you/);
    const group = view.host.querySelector('[role="radiogroup"]');
    assert.ok(group?.getAttribute('aria-labelledby'));
    assert.equal(view.radio('mentions')?.checked, true);
    assert.equal(view.radio('recent')?.disabled, false);
    const optOut = view.switchNamed('Don\'t let AI use my messages');
    assert.equal(optOut?.getAttribute('aria-checked'), 'false');
    const help = document.getElementById(optOut?.getAttribute('aria-describedby') ?? '');
    assert.match(help?.textContent ?? '', /Kordi's servers and up-to-date Kordi apps apply this\./);
    assert.equal(view.switchNamed('PiP plan helper')?.disabled, false);
    assert.equal(text.includes('Only group owners and admins can change this.'), false);
  } finally {
    await view.close();
  }
});

test('members get read-only scope and PiP but can still opt out', async () => {
  const { api, changes } = fakeApi(access({ viewer_can_manage: false, pip: { available: true, enabled: true, provider_label: 'OpenAI' } }),
    async () => access({ viewer_can_manage: false, viewer_excluded: true, excluded_member_ids: ['acct_c', 'acct_me'] }));
  const view = await render(api);
  try {
    assert.match(view.host.textContent ?? '', /Only group owners and admins can change this\./);
    assert.equal(view.radio('recent')?.disabled, true);
    assert.equal(view.switchNamed('PiP plan helper')?.disabled, true);
    await view.click(view.switchNamed('Don\'t let AI use my messages'));
    assert.deepEqual(changes, [{ exclude_my_messages: true }]);
    assert.equal(view.switchNamed('Don\'t let AI use my messages')?.getAttribute('aria-checked'), 'true');
    assert.match(view.host.textContent ?? '', /Turned on byCasey, You/);
  } finally {
    await view.close();
  }
});

test('choosing recent messages asks first and sends one change', async () => {
  const { api, changes } = fakeApi(access(), async (change) => access('history_scope' in change ? { history_scope: change.history_scope } : {}));
  const view = await render(api);
  try {
    await view.click(view.radio('recent'));
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.match(dialog?.textContent ?? '', /Let agents read recent messages\?/);
    assert.match(dialog?.textContent ?? '', /Everyone here will see a notice\./);
    assert.deepEqual(changes, []);
    await view.click([...(dialog?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Cancel') ?? null);
    assert.equal(document.body.querySelector('[role="dialog"]'), null);
    assert.deepEqual(changes, []);
    await view.click(view.radio('recent'));
    await view.click(document.body.querySelector('[aria-label="Allow agents to read recent messages"]'));
    assert.deepEqual(changes, [{ history_scope: 'recent' }]);
    assert.equal(view.radio('recent')?.checked, true);
    assert.match(view.host.textContent ?? '', /it can also read recent messages/);
    await view.click(view.radio('mentions'));
    assert.deepEqual(changes, [{ history_scope: 'recent' }, { history_scope: 'mentions' }]);
  } finally {
    await view.close();
  }
});

test('errors show inline with the server reason', async () => {
  const cases: Array<[CloudAuthError, RegExp]> = [
    [new CloudAuthError('PIP_UNAVAILABLE', 'x', 409), /PiP isn't available on this server\./],
    [new CloudAuthError('CHAT_FORBIDDEN', 'x', 403), /Only group owners and admins can change this\./],
    [new CloudAuthError('server_error', 'x', 500), /Couldn't update AI access\. Try again\./],
  ];
  for (const [error, copy] of cases) {
    const { api } = fakeApi(access(), async () => { throw error; });
    const view = await render(api);
    try {
      await view.click(view.switchNamed('PiP plan helper'));
      assert.match(view.host.querySelector('[role="alert"]')?.textContent ?? '', copy);
      assert.equal(view.switchNamed('PiP plan helper')?.getAttribute('aria-checked'), 'false');
    } finally {
      await view.close();
    }
  }
});

test('direct chats offer only the opt-out, and sync events refresh the panel', async () => {
  const { api, reads } = fakeApi(access({ pip: null, viewer_can_manage: false, history_scope: 'recent' }));
  const view = await render(api, 'direct');
  try {
    assert.equal(view.host.querySelector('[role="radiogroup"]'), null);
    assert.equal(view.switchNamed('PiP plan helper'), null);
    assert.ok(view.switchNamed('Don\'t let AI use my messages'));
    const before = reads();
    await act(async () => { dispatchWindowEvent(AI_ACCESS_UPDATED_EVENT, { sessionId: SESSION, conversationId: 'c1', aiAccess: null }); });
    await flushReactUpdates();
    assert.equal(reads(), before + 1);
  } finally {
    await view.close();
  }
});

test('servers without AI access settings show nothing', async () => {
  const calls = { aiAccess: async () => { throw new CloudAuthError('unknown', 'Not found', 404); } } as unknown as AgentTrustCalls;
  const view = await render({ session: async () => ({ token: 't', accountId: 'acct_me' }), calls });
  try {
    assert.equal(view.host.innerHTML, '');
  } finally {
    await view.close();
  }
});

test('turned-on-by names come from members, the viewer reads You', () => {
  const members = [
    { id: 'human:acct_c', name: 'Casey', kind: 'human', role: 'member', humanId: 'acct_c' },
    { id: 'human:acct_me', name: 'Me', kind: 'human', role: 'self', humanId: 'acct_me' },
    { id: 'agent:x', name: 'Scout', kind: 'agent', role: 'member', humanId: 'acct_x' },
  ] satisfies ConversationParticipant[];
  const map = aiAccessMemberNames(members);
  assert.equal(map.get('acct_c'), 'Casey');
  assert.equal(map.get('acct_me'), 'You');
  assert.equal(map.has('acct_x'), false);
  assert.equal(turnedOnByText([], map), 'No one');
  assert.equal(turnedOnByText(['acct_c', 'acct_gone'], map), 'Casey, A member');
});

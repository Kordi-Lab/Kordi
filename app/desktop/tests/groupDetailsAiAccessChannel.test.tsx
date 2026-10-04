import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { AgentTrustApi, AgentTrustCalls } from '../src/features/agentTrust/agentTrustApi';
import { buildParticipantSpaces } from '../src/features/chat/participantSpaces';
import type { AiAccessChange, ChatSyncAiAccess } from '../src/features/cloud/agentTrustTypes';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';
import { aiAccessChannel } from '../src/pages/groupDetailsDialog.helpers';
import { GroupDetailsDialog } from '../src/pages/GroupDetailsDialog';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';
import { conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';

const PLANS = 'session:group:weekend-plans';
const PHOTOS = 'session:group:weekend-photos';

function groupSpace() {
  const participants = [
    { id: 'human:me', name: 'Me', kind: 'human' as const, role: 'self', source: 'local' as const, avatarKey: 'me' },
    { id: 'human:maya', name: 'Maya', kind: 'human' as const, role: 'person', source: 'bridge' as const, avatarKey: 'maya' },
  ];
  const channel = (id: string, name: string, updatedAtMs: number) => conversation({
    id,
    canonicalSessionId: id,
    name,
    type: 'group',
    canonicalCreatedByIdentityId: 'human:me',
    metadata: { groupSpaceId: PLANS, groupCreatorIdentityId: 'human:me', adminIdentityIds: ['human:me'], customName: 'Weekend' },
    participants: ['Me', 'Maya'],
    canonicalParticipants: participants,
    _updatedAtMs: updatedAtMs,
  });
  // Photos is the newer channel, so it comes first in the group.
  const [space] = buildParticipantSpaces([channel(PLANS, 'Plans', 1), channel(PHOTOS, 'Photos', 2)]);
  return space;
}

function access(overrides: Partial<ChatSyncAiAccess> = {}): ChatSyncAiAccess {
  return {
    history_scope: 'mentions',
    pip: { available: true, enabled: false, provider_label: 'OpenAI' },
    excluded_member_ids: [],
    viewer_excluded: false,
    viewer_can_manage: true,
    ...overrides,
  };
}

function fakeApi() {
  const reads: string[] = [];
  const updates: Array<[string, AiAccessChange]> = [];
  const calls = {
    aiAccess: async (_token: string, sessionId: string) => {
      reads.push(sessionId);
      return access();
    },
    updateAiAccess: async (_token: string, sessionId: string, change: AiAccessChange) => {
      updates.push([sessionId, change]);
      const next = access('exclude_my_messages' in change ? { viewer_excluded: Boolean(change.exclude_my_messages) } : {});
      return { id: sessionId, legacy_session_id: sessionId, ai_access: next } as unknown as ChatSyncConversation;
    },
  } as unknown as AgentTrustCalls;
  const api: AgentTrustApi = { session: async () => ({ token: 'token', accountId: 'acct_me' }), calls };
  return { api, reads, updates };
}

test('the AI access channel follows the pick, then the open channel, then the first', () => {
  const space = groupSpace();
  assert.equal(space?.sessions.length, 2);
  assert.equal(space?.sessions[0]?.id, PHOTOS);
  assert.equal(aiAccessChannel(space, PLANS, null)?.id, PLANS);
  assert.equal(aiAccessChannel(space, PLANS, PHOTOS)?.id, PHOTOS);
  assert.equal(aiAccessChannel(space, 'session:direct-person:elsewhere', null)?.id, PHOTOS);
  assert.equal(aiAccessChannel(null, PLANS, null), null);
});

test('group details change AI access for the channel that is open, and name it', async () => {
  const space = groupSpace();
  const { api, reads, updates } = fakeApi();
  const installed = installDom();
  // React's legacy input polyfill runs when the dialog focuses its search box.
  Object.assign(installed.dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const panel = () => document.body.querySelector<HTMLElement>('[data-ai-access-panel]');
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, 'element exists');
    await act(async () => { (element as HTMLElement).click(); });
    await flushReactUpdates();
  };
  try {
    await act(async () => {
      root.render(createElement(GroupDetailsDialog, {
        isOpen: true,
        space,
        activeSessionId: PLANS,
        contacts: [],
        currentAccountId: 'acct_me',
        onClose: () => {},
        onRename: () => {},
        onAddMembers: () => {},
        onRemoveMember: () => {},
        onSetAdmin: () => {},
        aiAccessApi: api,
      }));
    });
    await flushReactUpdates();
    assert.deepEqual(reads, [PLANS]);
    assert.equal(panel()?.querySelector('h3')?.textContent, 'AI access for Plans');
    const optOut = () => panel()?.querySelector('[role="switch"][aria-label="Don\'t let AI use my messages"]');
    await click(optOut());
    assert.deepEqual(updates, [[PLANS, { exclude_my_messages: true }]]);

    // The other channel is one choice away and keeps its own settings.
    const select = panel()?.querySelector('select');
    assert.ok(select);
    assert.equal(document.body.querySelector(`label[for="${select.id}"]`)?.textContent?.startsWith('Channel'), true);
    assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [[PHOTOS, 'Photos'], [PLANS, 'Plans']]);
    await act(async () => {
      select.value = PHOTOS;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await flushReactUpdates();
    assert.equal(reads.at(-1), PHOTOS);
    assert.equal(panel()?.querySelector('h3')?.textContent, 'AI access for Photos');
    await click(panel()?.querySelector('[role="switch"][aria-label="PiP plan helper"]'));
    assert.deepEqual(updates.at(-1), [PHOTOS, { pip_enabled: true }]);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

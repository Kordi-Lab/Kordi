import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useCallback, useEffect, useMemo, useState } from 'react';

import { acceptedCloudGroupConversationId } from '../src/app/acceptedCloudGroupConversationId';
import { ACCEPTED_GROUP_SYNCING_NOTICE, useAcceptedCloudGroupNavigation } from '../src/app/useAcceptedCloudGroupNavigation';
import { useWorkspaceController } from '../src/app/useWorkspaceController';
import { useWorkspaceViewModels } from '../src/app/useWorkspaceViewModels';
import { chatNavigationIndex } from '../src/features/chat/chatNavigation';
import { activeConversationForSelection } from '../src/app/viewModels/conversationSelection';
import { nativeChatPlaceholderForSelection } from '../src/app/viewModels/nativeChatSelection';
import { collaborationGroupSessionSendTargets } from '../src/features/chat/messageActions/collaborationRouting';
import { cloudGroupTargetAccountIds } from '../src/features/cloud/cloudGroupMessages';
import { dispatchCloudGroupInvitationAccepted } from '../src/features/cloud/groupInvitationDeepLink';
import type { Conversation, NavId } from '../src/kordi-app/types';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const GROUP_SESSION_ID = 'session:group:6f0c2a1e-0000-4000-8000-0000fbb535a1';

function conversation(id: string, name: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    canonicalSessionId: id,
    name,
    type: 'person',
    subtitle: '',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: 'Person chat',
    participants: ['Me'],
    messages: [],
    ...extra,
  };
}

const nadia = conversation('session:direct-person:acct_me:acct_nadia', 'Nadia');
const newGroup = conversation(GROUP_SESSION_ID, 'Personal agent memory', {
  type: 'owned-agent',
  directness: 'Group chat',
  participantSpaceId: GROUP_SESSION_ID,
});

function select(activeId: string, chats: Conversation[]) {
  return activeConversationForSelection(activeId, chats, {
    isNativeShell: true,
    nativeChatPlaceholder: nativeChatPlaceholderForSelection(activeId),
    fallbackConversation: chats[0],
  });
}

test('both group id forms resolve to the canonical group session id', () => {
  assert.equal(acceptedCloudGroupConversationId(GROUP_SESSION_ID), GROUP_SESSION_ID);
  assert.equal(acceptedCloudGroupConversationId(`group:${GROUP_SESSION_ID}`), GROUP_SESSION_ID);
  assert.equal(acceptedCloudGroupConversationId(`  ${GROUP_SESSION_ID} `), GROUP_SESSION_ID);
  assert.equal(acceptedCloudGroupConversationId(''), '');
  assert.equal(acceptedCloudGroupConversationId(undefined), '');
});

test('the old group: prefixed id matched no chat and fell back to the last direct chat', () => {
  // The pre-fix navigation id: the shell showed Nadia instead of the new group.
  assert.equal(select(`group:${GROUP_SESSION_ID}`, [nadia, newGroup]).name, 'Nadia');
});

const NADIA_SESSION_ID = 'session:direct-person:acct_me:acct_nadia';

/** Canonical state shaped like the server's Common ground group: owner + the System agent, no messages yet. */
function canonicalState(withGroup: boolean) {
  const at = (ms: number) => ({ createdAtMs: ms, updatedAtMs: ms });
  return {
    storagePath: '/tmp/canonical.sqlite3',
    profile: { id: 'profile:me', displayName: 'Me', humanIdentityId: 'human:me', activeAgentIdentityId: null, storageRoot: '/tmp', ...at(1) },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', ...at(1) },
      { id: 'human:nadia', kind: 'human', displayName: 'Nadia', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_nadia', humanId: 'acct_nadia', avatarKey: 'nadia', ...at(1) },
      { id: 'human:acct_kordi_pip', kind: 'human', displayName: 'Kordi', source: 'bridge', sourceHostId: 'cloud', sourceIdentityId: 'acct_kordi_pip', humanId: 'acct_kordi_pip', avatarKey: 'system-agent', ...at(1) },
    ],
    sessions: [
      { id: NADIA_SESSION_ID, kind: 'direct-person', title: 'Nadia', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: 'human:nadia', relationshipIdentityId: 'human:nadia', metadata: { source: 'cloud-direct' }, ...at(2), lastMessageAtMs: 2 },
      ...(withGroup ? [{
        id: GROUP_SESSION_ID, kind: 'group', title: 'New chat', status: 'active', createdByIdentityId: 'human:me', primaryIdentityId: null, relationshipIdentityId: null,
        metadata: { schemaVersion: 1, kind: 'chat-group', customName: 'Agent design and personalization', groupId: GROUP_SESSION_ID, groupSpaceId: GROUP_SESSION_ID, createdFrom: 'cloud-group-sync' },
        ...at(5), lastMessageAtMs: null,
      }] : []),
    ],
    participants: [
      { sessionId: NADIA_SESSION_ID, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId: NADIA_SESSION_ID, identityId: 'human:nadia', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      ...(withGroup ? [
        { sessionId: GROUP_SESSION_ID, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 5 },
        { sessionId: GROUP_SESSION_ID, identityId: 'human:acct_kordi_pip', role: 'person', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 5 },
      ] : []),
    ],
    messages: [
      { id: 'msg:nadia', sessionId: NADIA_SESSION_ID, senderIdentityId: 'human:nadia', senderRole: 'person', messageKind: 'text', contentText: 'Earlier message from Nadia', content: { sender: 'Nadia', timeLabel: '10:00' }, status: 'sent', sequenceNum: 1, ...at(2), contentHash: null, sourceTransport: 'cloud-direct', sourceEventId: 'cloud_1' },
    ],
    delegatedExchanges: [], contextSnapshots: [], presence: [],
  };
}

type Frame = { nav: string; activeId: string; shownId: string; shownName: string; error: string | null };

/**
 * The real navigation controller, chat list view model and navigation index,
 * with a group that reaches the list `arrivesAfterMs` after the refresh
 * resolves (never when null).
 */
async function openStartedGroup({ arrivesAfterMs, dropsOutAfterMs, refreshError, waitAttempts, waitIntervalMs }: {
  arrivesAfterMs: number | null;
  /** The group leaves the list for 30 ms this long after it arrives. */
  dropsOutAfterMs?: number;
  refreshError?: Error;
  waitAttempts?: number;
  waitIntervalMs?: number;
}) {
  const frames: Frame[] = [];
  let navigate: (nav: NavId) => void = () => {};
  let afterDispatch = -1;
  await withJsdomRoot(async (mount) => {
    const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
    Object.defineProperty(globalThis, 'CustomEvent', { value: window.CustomEvent, configurable: true, writable: true });
    function Harness() {
      const controller = useWorkspaceController({ initialProjects: [], isNativeShell: true });
      const [groupSynced, setGroupSynced] = useState(false);
      const [error, setError] = useState<string | null>('This chat is unavailable. Try again from the chat list.');
      navigate = controller.setActiveNav;
      const canonical = useMemo(() => canonicalState(groupSynced), [groupSynced]);
      const viewModels = useWorkspaceViewModels({
        isNativeShell: true, isDesktopChatLoading: false, desktopChatState: null, desktopCollaborationState: null,
        canonicalSessionState: canonical as never, hiddenSessionIds: new Set(), projectWorkspaces: [], projectSelectedSessionIds: {},
        activeNav: controller.activeNav, activeConvId: controller.activeConvId, activeProjectId: '', activeProjectSessionId: '',
        chatSearch: '', projectSearch: '', contactSearch: '', activeContactId: '', activeAgentId: '',
        cachedChatSessionMessages: {}, cachedProjectSessionMessages: {}, localSessionUnreadCounts: {},
        desktopLiveTurnsBySession: {}, mapDesktopMessages: () => [],
      });
      const destinations = useMemo(() => chatNavigationIndex(viewModels.chatConversations), [viewModels.chatConversations]);
      const { updateChatNavigationIndex } = controller;
      useEffect(() => updateChatNavigationIndex(destinations), [destinations, updateChatNavigationIndex]);
      const hasConversation = useCallback((id: string) => destinations.has(id), [destinations]);
      const refreshCloudMessages = useCallback(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (arrivesAfterMs !== null) setTimeout(() => setGroupSynced(true), arrivesAfterMs);
        if (arrivesAfterMs !== null && dropsOutAfterMs !== undefined) {
          setTimeout(() => setGroupSynced(false), arrivesAfterMs + dropsOutAfterMs);
          setTimeout(() => setGroupSynced(true), arrivesAfterMs + dropsOutAfterMs + 30);
        }
        if (refreshError) throw refreshError;
      }, []);
      useAcceptedCloudGroupNavigation({
        activeConversationId: controller.activeConvId,
        hasConversation,
        refreshCloudMessages,
        setActiveConversationId: controller.setActiveConvId,
        setActiveNavigation: controller.setActiveNav,
        setDesktopChatError: setError,
        waitAttempts,
        waitIntervalMs,
      });
      frames.push({
        nav: controller.activeNav,
        activeId: controller.activeConvId,
        shownId: viewModels.activeConv.id,
        shownName: viewModels.activeConv.name,
        error,
      });
      return null;
    }
    try {
      await mount(<Harness />);
      // The owner had Nadia open in Chats, then went to Contacts → Common ground.
      await act(async () => { navigate('chats'); });
      assert.equal(frames.at(-1)?.activeId, NADIA_SESSION_ID);
      await act(async () => { navigate('contacts'); });
      afterDispatch = frames.length;
      await act(async () => {
        dispatchCloudGroupInvitationAccepted({ groupId: GROUP_SESSION_ID, groupSpaceId: GROUP_SESSION_ID, groupTitle: '' });
      });
      // Short act windows so React commits the late list between polls.
      for (let elapsed = 0; elapsed < 700; elapsed += 25) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
      }
    } finally {
      if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', previousCustomEvent);
      else delete (globalThis as Record<string, unknown>).CustomEvent;
    }
  });
  return { frames: frames.slice(afterDispatch), last: frames.at(-1)! };
}

test('a group that reaches the chat list after the refresh opens, never the first chat meanwhile', async () => {
  const { frames, last } = await openStartedGroup({ arrivesAfterMs: 150 });
  // Selection waits on Contacts until the list holds the group; Chats never shows Nadia.
  assert.deepEqual(frames.filter((frame) => frame.nav === 'chats' && frame.shownId !== GROUP_SESSION_ID), []);
  assert.equal(last.nav, 'chats');
  assert.equal(last.activeId, GROUP_SESSION_ID);
  assert.equal(last.shownId, GROUP_SESSION_ID);
  assert.notEqual(last.shownName, 'Opening group chat…');
  assert.equal(last.error, null);
});

test('a group that drops out of the list briefly after opening is selected again', async () => {
  // Without the re-selection, navigation reconciliation clears the vanished
  // selection and settles on the first chat (Nadia), even after the group returns.
  const { frames, last } = await openStartedGroup({ arrivesAfterMs: 50, dropsOutAfterMs: 300, waitIntervalMs: 25 });
  assert.ok(frames.some((frame) => frame.nav === 'chats' && frame.shownId === NADIA_SESSION_ID));
  assert.equal(last.nav, 'chats');
  assert.equal(last.activeId, GROUP_SESSION_ID);
  assert.equal(last.shownId, GROUP_SESSION_ID);
});

test('a group that never syncs in time still opens on its placeholder with a one-line notice', async () => {
  const { frames, last } = await openStartedGroup({ arrivesAfterMs: null, waitAttempts: 3, waitIntervalMs: 20 });
  assert.deepEqual(frames.filter((frame) => frame.nav === 'chats' && frame.shownId !== GROUP_SESSION_ID), []);
  assert.equal(last.nav, 'chats');
  assert.equal(last.shownId, GROUP_SESSION_ID);
  assert.equal(last.shownName, 'Opening group chat…');
  assert.equal(last.error, ACCEPTED_GROUP_SYNCING_NOTICE);
});

test('a failed refresh reports the error and keeps the current page', async () => {
  const { frames, last } = await openStartedGroup({ arrivesAfterMs: null, refreshError: new Error('Chat sync failed.') });
  assert.deepEqual(frames.filter((frame) => frame.nav === 'chats'), []);
  assert.equal(last.nav, 'contacts');
  assert.equal(last.error, 'Chat sync failed.');
});

test('a group whose invitees have not joined yet has no Cloud send target', () => {
  // Documents the send-path condition behind "This chat is unavailable":
  // chatMessages.ts only takes the Cloud group branch when targets exist.
  const soloGroup = {
    canonicalParticipants: [
      { id: 'me', name: 'Me', kind: 'human', role: 'self', source: 'cloud', sourceHostId: 'cloud', sourceIdentityId: 'acct_me' },
      { id: 'agent', name: 'Kordi', kind: 'agent', role: 'agent', source: 'cloud', sourceHostId: 'cloud', sourceIdentityId: 'acct_me' },
    ],
  } as unknown as Pick<Conversation, 'canonicalParticipants'>;
  assert.deepEqual(cloudGroupTargetAccountIds(collaborationGroupSessionSendTargets(soloGroup, null, ['acct_me'])), []);
});

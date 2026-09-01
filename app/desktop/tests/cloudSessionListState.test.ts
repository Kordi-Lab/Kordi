import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  applyCloudSyncEventsToSessionVisibility,
  type CloudSessionVisibilityState,
} from '../src/features/cloud/cloudDiffSync';
import type { CloudSyncEvent } from '../src/features/cloud/authClient';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { buildWorkspaceChatListViewModels, workspaceArchivedSessionIds } from '../src/app/workspaceChatListViewModels';

const chatSessionActionsSource = () => readFileSync(new URL('../src/app/useKordiChatSessionActions.ts', import.meta.url), 'utf8');
const cloudSessionActionsSource = () => readFileSync(new URL('../src/features/cloud/useCloudSessionActions.ts', import.meta.url), 'utf8');
const workspaceViewModelsSource = () => readFileSync(new URL('../src/app/useWorkspaceViewModels.ts', import.meta.url), 'utf8');

function event(eventType: string, sessionId: string): CloudSyncEvent {
  return {
    eventId: `${eventType}:${sessionId}`,
    eventType,
    peerAccountId: null,
    messageId: null,
    payload: { sessionId },
    occurredAt: '2026-08-31T00:00:00Z',
  };
}

test('session list events keep archive stable and isolate preference transitions', () => {
  const initial: CloudSessionVisibilityState = {
    hiddenSessionIds: new Set(['session:archived']),
    deletedSessionIds: new Set(['session:deleted']),
    unreadSessionIds: new Set(['session:one']),
    pinnedSessionIds: new Set(['session:one']),
    mutedSessionIds: new Set(['session:one']),
    pinnedGroupSpaceIds: new Set(),
  };
  const next = applyCloudSyncEventsToSessionVisibility('acct_me', initial, [
    {
      ...event('message.upsert', 'session:archived'),
      payload: { sessionId: 'session:archived', message: {} },
    },
    event('session.unhidden', 'session:deleted'),
    event('session.hidden', 'session:one'),
    event('session.deleted', 'session:one'),
    event('group_space.pinned', 'session:group:mobile'),
  ]);

  assert.deepEqual([...next.hiddenSessionIds], ['session:archived']);
  assert.deepEqual([...next.deletedSessionIds], ['session:one']);
  assert.deepEqual([...next.pinnedSessionIds], []);
  assert.deepEqual([...next.mutedSessionIds], []);
  assert.deepEqual([...next.unreadSessionIds], []);
  assert.deepEqual([...next.pinnedGroupSpaceIds], ['session:group:mobile']);
});

test('manual unread and group pin events synchronize account preferences', () => {
  const empty: CloudSessionVisibilityState = {
    hiddenSessionIds: new Set(),
    deletedSessionIds: new Set(),
    unreadSessionIds: new Set(),
    pinnedSessionIds: new Set(),
    mutedSessionIds: new Set(),
    pinnedGroupSpaceIds: new Set(),
  };
  const selected = applyCloudSyncEventsToSessionVisibility('acct_me', empty, [
    event('session.marked_unread', 'session:one'),
    event('group_space.pinned', 'session:group:mobile'),
  ]);
  assert.deepEqual([...selected.unreadSessionIds], ['session:one']);
  assert.deepEqual([...selected.pinnedGroupSpaceIds], ['session:group:mobile']);

  const cleared = applyCloudSyncEventsToSessionVisibility('acct_me', selected, [
    event('session.unmarked_unread', 'session:one'),
    event('group_space.unpinned', 'session:group:mobile'),
  ]);
  assert.deepEqual([...cleared.unreadSessionIds], []);
  assert.deepEqual([...cleared.pinnedGroupSpaceIds], []);
});

test('unpin, unmute, and restore events clear their synchronized state', () => {
  const selected: CloudSessionVisibilityState = {
    hiddenSessionIds: new Set(['session:one']),
    deletedSessionIds: new Set(['session:one']),
    unreadSessionIds: new Set(),
    pinnedSessionIds: new Set(['session:one']),
    mutedSessionIds: new Set(['session:one']),
    pinnedGroupSpaceIds: new Set(['session:group:mobile']),
  };
  const cleared = applyCloudSyncEventsToSessionVisibility('acct_me', selected, [
    event('session.unhidden', 'session:one'),
    event('session.unpinned', 'session:one'),
    event('session.unmuted', 'session:one'),
    event('group_space.unpinned', 'session:group:mobile'),
  ]);

  assert.deepEqual([...cleared.hiddenSessionIds], []);
  assert.deepEqual([...cleared.deletedSessionIds], []);
  assert.deepEqual([...cleared.pinnedSessionIds], []);
  assert.deepEqual([...cleared.mutedSessionIds], []);
  assert.deepEqual([...cleared.pinnedGroupSpaceIds], []);
});

test('cloud remove archives matching local canonical sessions after server removal succeeds', () => {
  const source = chatSessionActionsSource();
  const deleteStart = source.indexOf('if (shouldUseCloudSessionAction(trimmedSessionId, canonicalState)) {', source.indexOf('const deleteSession'));
  const cloudDeleteBranch = source.slice(deleteStart, source.indexOf('} catch (error) {', deleteStart));
  assert.match(cloudDeleteBranch, /await deleteCloudSession\(trimmedSessionId\);[\s\S]*archiveDesktopChatSession\(\s*trimmedSessionId,\s*desktopActiveSessionId/);
  assert.match(cloudDeleteBranch, /optimisticallyRemoveSession\(trimmedSessionId, false\)/);
  const archiveStart = source.indexOf('if (shouldUseCloudSessionAction(trimmedSessionId, canonicalState)) {', source.indexOf('const archiveSession'));
  assert.match(
    source.slice(archiveStart, source.indexOf('}', archiveStart)),
    /optimisticallyRemoveSession\(trimmedSessionId, false\)/,
  );
});

test('archived local agent sessions remain available only in archived chats', () => {
  const sessionId = 'local-agent-session';
  const canonicalState = {
    storagePath: '/tmp/canonical.sqlite3',
    profile: { id: 'profile', humanIdentityId: 'human:me', createdAtMs: 1, updatedAtMs: 1 },
    identities: [],
    sessions: [{
      id: sessionId,
      kind: 'self-agent',
      title: 'Archived agent session',
      status: 'archived',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'agent:me',
      createdAtMs: 1,
      updatedAtMs: 2,
    }],
    participants: [],
    messages: [{
      id: 'message:one',
      sessionId,
      senderIdentityId: 'human:me',
      senderRole: 'user',
      messageKind: 'text',
      contentText: 'Keep this archived session visible',
      status: 'sent',
      sequenceNum: 1,
      createdAtMs: 2,
      updatedAtMs: 2,
      sourceTransport: 'desktop-chat',
    }],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never;
  const allConversations = createCanonicalSessionReadModel(canonicalState)
    ?.buildChatConversations([], () => '') ?? [];
  const viewModels = buildWorkspaceChatListViewModels({
    activeConversationId: '',
    allConversations,
    archivedSessionIds: new Set([sessionId]),
    avatarSeed: 'profile',
    chatSearch: '',
    hiddenSessionIds: new Set(),
    localAgentReachoutSessionIds: new Set(),
  });

  assert.equal(viewModels.chatConversations.some((conversation) => conversation.id === sessionId), false);
  assert.equal(
    viewModels.archivedParticipantSpaces.some((space) =>
      space.sessions.some((session) => session.id === sessionId)
    ),
    true,
  );
  assert.deepEqual([...workspaceArchivedSessionIds(canonicalState, new Set())], [sessionId]);
  assert.match(workspaceViewModelsSource(), /workspaceArchivedSessionIds\(canonicalSessionState, archivedSessionIds\)/);
});

test('preference refresh ignores stale snapshots from overlapping actions', () => {
  const source = cloudSessionActionsSource();
  assert.match(source, /const generation = \+\+visibilityRefreshGenerationRef\.current;/);
  assert.match(source, /if \(generation !== visibilityRefreshGenerationRef\.current\) return;/);
});

test('chat list mutations surface action failures without unhandled rejections', () => {
  const source = chatSessionActionsSource();
  assert.match(source, /const runChatListAction = useCallback/);
  assert.match(source, /setDesktopError\(error instanceof Error \? error\.message : fallbackMessage\)/);
  assert.doesNotMatch(
    source.slice(source.indexOf('const archiveSession'), source.indexOf('const deleteSession')),
    /throw error/,
  );
});

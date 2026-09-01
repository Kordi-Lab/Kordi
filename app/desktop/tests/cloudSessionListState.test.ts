import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  applyCloudSyncEventsToSessionVisibility,
  type CloudSessionVisibilityState,
} from '../src/features/cloud/cloudDiffSync';
import type { CloudSyncEvent } from '../src/features/cloud/authClient';

const chatSessionActionsSource = () => readFileSync(new URL('../src/app/useKordiChatSessionActions.ts', import.meta.url), 'utf8');
const cloudSessionActionsSource = () => readFileSync(new URL('../src/features/cloud/useCloudSessionActions.ts', import.meta.url), 'utf8');

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

test('preference refresh ignores stale snapshots from overlapping actions', () => {
  const source = cloudSessionActionsSource();
  assert.match(source, /const generation = \+\+visibilityRefreshGenerationRef\.current;/);
  assert.match(source, /if \(generation !== visibilityRefreshGenerationRef\.current\) return;/);
});

test('archive and pin mutations update local visibility before the network', () => {
  const source = cloudSessionActionsSource();
  const optimisticMutation = source.slice(
    source.indexOf('const runOptimisticVisibilityMutation ='),
    source.indexOf('const refreshActivity ='),
  );
  const hide = source.slice(source.indexOf('const hide ='), source.indexOf('const unhide ='));
  const pin = source.slice(source.indexOf('const setPinned ='), source.indexOf('const setMuted ='));
  const groupPin = source.slice(source.indexOf('const setGroupPinned ='), source.indexOf('const remove ='));

  assert.match(optimisticMutation, /setIdPresence\([\s\S]*await commit\(session\.token\)/);
  assert.match(optimisticMutation, /catch \(error\)[\s\S]*setIdPresence\(/);
  assert.match(hide, /hiddenIdsRef[\s\S]*client\.hideCloudSession/);
  assert.match(pin, /pinnedIdsRef[\s\S]*client\.setCloudSessionPinned/);
  assert.match(groupPin, /pinnedGroupSpaceIdsRef[\s\S]*client\.setCloudGroupSpacePinned/);
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildProjectRoutingGroups,
  rememberProjectMembership,
} from '../src/features/canonical/sessionResolver';
import { localProjectSessionHints } from '../src/features/projects/localProjectSessions';
import { projectChatGroups } from '../src/features/projects/projectChatGroups';
import type { ChatSidebarRow } from '../src/pages/sidebar/chatSidebarRows';
import type {
  CanonicalSessionState,
  DesktopChatProjectGroup,
  DesktopChatSessionDetail,
  DesktopChatSessionSummary,
  DesktopChatState,
} from '../src/kordi-app/types';

const PROJECT_ROOT = '/Users/example/KordiWorktrees';
const PROJECT_ID = `project:${PROJECT_ROOT}`;

function summary(id: string, updatedAtMs = 1): DesktopChatSessionSummary {
  return { id, title: id, subtitle: '', updatedAtLabel: 'Now', updatedAtMs, messageCount: 1, draft: false };
}

function detail(id: string, cwd: string, overrides: Partial<DesktopChatSessionDetail> = {}) {
  return {
    ...summary(id, 5), cwd, provider: 'p', providerLabel: 'P', model: 'm', modelLabel: 'M',
    thinking: 'auto', thinkingLabel: 'Auto', thinkingLevels: [], contextWindowText: '',
    messages: [], ...overrides,
  } as unknown as DesktopChatSessionDetail;
}

function desktopState(
  active: DesktopChatSessionDetail,
  projectSessions: DesktopChatSessionSummary[],
  chatSessions: DesktopChatSessionSummary[] = [summary('plain')],
): DesktopChatState {
  const project: DesktopChatProjectGroup = {
    id: PROJECT_ID, name: 'KordiWorktrees', root: PROJECT_ROOT, summary: '', sharedSources: [], sessions: projectSessions,
  };
  return {
    cwd: '/Users/example', activeSessionId: active.id, sessions: chatSessions, projects: [project], activeSession: active,
  } as unknown as DesktopChatState;
}

function canonicalSession(id: string): CanonicalSessionState {
  return {
    sessions: [{ id, kind: 'self-agent', title: id, status: 'active', createdByIdentityId: 'me', createdAtMs: 1, updatedAtMs: 2 }],
    messages: [],
  } as unknown as CanonicalSessionState;
}

function route(state: DesktopChatState, membership: ReadonlyMap<string, string>, canonical?: CanonicalSessionState) {
  const hints = localProjectSessionHints(state, canonical);
  const groups = buildProjectRoutingGroups(state.projects, canonical, {
    sessionHints: hints.sessionHints,
    unboundSessionIds: hints.unboundSessionIds,
    previousGroupIdBySession: membership,
  });
  return { groups, membership: rememberProjectMembership(membership, groups, hints.unboundSessionIds) };
}

function sidebarSections(groups: ReturnType<typeof route>['groups'], sessionIds: string[]) {
  const rows: ChatSidebarRow[] = sessionIds.map((sessionId) => ({
    kind: 'session', key: `session:${sessionId}`, sessionId, spaceId: 'agent', depth: 0, activePath: false,
  }));
  const projects = groups.map((group) => ({ id: group.id, name: group.id, sessions: group.sessions }));
  const keys = projectChatGroups(rows, projects, new Set()).rows.map((row) => row.key);
  return {
    project: keys.filter((key) => key.startsWith(`project:${PROJECT_ID}:`)).map((key) => key.split('session:').pop()),
    recents: keys.filter((key) => key.startsWith('recent:')).map((key) => key.slice('recent:session:'.length)),
  };
}

test('a chat working inside a project root is listed under it before the catalog lists it', () => {
  for (const cwd of [PROJECT_ROOT, `${PROJECT_ROOT}/worktrees/feature`]) {
    const { groups } = route(desktopState(detail('hiiii', cwd), []), new Map());
    assert.deepEqual(groups.find((group) => group.id === PROJECT_ID)?.sessions.map((session) => session.id), ['hiiii']);
    assert.deepEqual(sidebarSections(groups, ['hiiii', 'plain']), { project: ['hiiii'], recents: ['plain'] });
  }
});

test('a sibling folder sharing the root prefix does not bind to the project', () => {
  const { groups } = route(desktopState(detail('hiiii', `${PROJECT_ROOT}-other`), []), new Map());
  assert.deepEqual(sidebarSections(groups, ['hiiii', 'plain']).recents, ['hiiii', 'plain']);
});

test('project membership survives a catalog refresh that omits the session', () => {
  const first = route(desktopState(detail('hiiii', PROJECT_ROOT), [summary('hiiii')]), new Map());
  assert.equal(first.membership.get('hiiii'), PROJECT_ID);
  const refreshed = route(desktopState(detail('plain', '/Users/example'), []), first.membership, canonicalSession('hiiii'));
  assert.deepEqual(sidebarSections(refreshed.groups, ['hiiii', 'plain']), { project: ['hiiii'], recents: ['plain'] });
  assert.equal(refreshed.membership.get('hiiii'), PROJECT_ID);
});

test('a chat that leaves its project returns to Recents', () => {
  const first = route(desktopState(detail('hiiii', PROJECT_ROOT), [summary('hiiii')]), new Map());
  const listedAsChat = route(
    desktopState(detail('plain', '/Users/example'), [], [summary('plain'), summary('hiiii')]),
    first.membership,
  );
  assert.deepEqual(sidebarSections(listedAsChat.groups, ['hiiii', 'plain']), { project: [], recents: ['hiiii', 'plain'] });
  assert.equal(listedAsChat.membership.has('hiiii'), false);
  const backToDefault = route(desktopState(detail('hiiii', '/Users/example'), []), first.membership);
  assert.deepEqual(sidebarSections(backToDefault.groups, ['hiiii', 'plain']).recents, ['hiiii', 'plain']);
});

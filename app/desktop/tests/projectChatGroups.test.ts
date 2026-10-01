import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectChatGroups, projectScopedSidebarSessions } from '../src/features/projects/projectChatGroups';
import type { ChatSidebarRow } from '../src/pages/sidebar/chatSidebarRows';

const rows: ChatSidebarRow[] = ['one', 'two', 'three'].map((id) => ({
  kind: 'session', key: `session:${id}`, sessionId: id, spaceId: 'agent', depth: 0, activePath: id === 'one',
}));
const projects = [{ id: 'app', name: 'App', sessions: [{ id: 'one' }, { id: 'three' }] }];

test('project collapse preserves session identity and keeps active chats discoverable in Recents', () => {
  const grouped = projectChatGroups(rows, projects, new Set());
  assert.deepEqual(grouped.rows.map((row) => row.key), ['agent-section:projects', 'project-group:app', 'project:app:session:one', 'project:app:session:three', 'agent-section:recents', 'recent:session:one', 'recent:session:two', 'recent:session:three']);
  assert.equal(grouped.rows[2].kind === 'session' && grouped.rows[2].sessionId, 'one');
  assert.deepEqual(projectChatGroups(rows, projects, new Set(['app'])).rows.map((row) => row.key), ['agent-section:projects', 'project-group:app', 'agent-section:recents', 'recent:session:one', 'recent:session:two', 'recent:session:three']);
});

test('moving or removing membership keeps every chat discoverable in Recents after projects', () => {
  const moved = [{ id: 'other', name: 'Other', sessions: [{ id: 'two' }] }];
  const grouped = projectChatGroups(rows, moved, new Set());
  assert.equal(grouped.groups.get('other')?.rows.length, 1);
  assert.equal(grouped.rows[1].key, 'project-group:other');
  const unassigned = projectChatGroups(rows, [], new Set());
  assert.equal(unassigned.rows[0].key, 'agent-section:recents');
  assert.deepEqual(unassigned.rows.slice(1).map((row) => row.kind === 'session' && row.sessionId), ['one', 'two', 'three']);
  assert.deepEqual(projectChatGroups(rows, [], new Set(['section:recents'])).rows.map((row) => row.key), ['agent-section:recents']);
});

test('a fork moved to another project remains visible independently of its original parent', () => {
  const child = { session: { id: 'child', forkedFromSessionId: 'parent', forkedFromMessageId: 'message', conversation: { forkedFromSessionId: 'parent' } } };
  const scoped = projectScopedSidebarSessions([child], [{ id: 'app', name: 'App', sessions: [{ id: 'child' }] }]);
  assert.equal(scoped[0].session.forkedFromSessionId, null);
  assert.strictEqual(scoped[0].session.conversation, child.session.conversation);
  assert.strictEqual(projectScopedSidebarSessions([child], [])[0], child);
});

test('explicit empty project sessions survive blank-chat deduplication', async () => {
  const { collapseBlankConversationShells, buildParticipantSpaces } = await import('../src/features/chat/participantSpaces');
  const { conversation } = await import('./helpers/workspaceSidebarParticipantSpacesFixtures');
  const sessions = ['first', 'second'].map((id) => conversation({ id, canonicalSessionId: id, name: 'New session', type: 'owned-agent', messages: [],
    metadata: { projectRoot: `/fixture/${id}` }, participants: ['Me', 'Kordi'], canonicalParticipants: [
      { id: 'human:me', name: 'Me', kind: 'human', role: 'self', source: 'local' },
      { id: 'agent:me', name: 'Kordi', kind: 'agent', role: 'owned-agent', source: 'local' },
    ],
  }));
  assert.equal(collapseBlankConversationShells(sessions).length, 2);
  assert.equal(buildParticipantSpaces(sessions).flatMap((space) => space.sessions).length, 2);
});

test('empty project folders remain available outside search and archive views', () => {
  const emptyProject = { id: 'empty', name: 'Empty', sessions: [] };
  const grouped = projectChatGroups(rows, [emptyProject], new Set(), true);
  assert(grouped.rows.some((row) => row.kind === 'space' && row.spaceId === 'empty'));
  assert.deepEqual(projectChatGroups(rows, [emptyProject], new Set(), false).rows.map((row) => row.key), ['agent-section:recents', 'recent:session:one', 'recent:session:two', 'recent:session:three']);
});

test('pinned chats lead the sidebar and retain project membership with distinct virtual keys', () => {
  const grouped = projectChatGroups(rows, projects, new Set(), true, { pinnedSessionIds: new Set(['one']) });
  assert.deepEqual(grouped.rows.slice(0, 2).map((row) => row.key), ['agent-section:pinned', 'pinned:session:one']);
  assert(grouped.rows.some((row) => row.key === 'project:app:session:one'));
  assert(!grouped.rows.some((row) => row.key === 'recent:session:one'));
  assert.equal(new Set(grouped.rows.map((row) => row.key)).size, grouped.rows.length);
});

test('project previews keep fork trees together and show all matches while searching', () => {
  const tree: ChatSidebarRow[] = [
    { ...rows[0], depth: 0 }, { ...rows[1], depth: 1 }, { ...rows[2], depth: 0 },
  ];
  const project = [{ id: 'tree', name: 'Tree', sessions: ['one', 'two', 'three'].map((id) => ({ id })) }];
  const preview = projectChatGroups(tree, project, new Set(), true, { previewLimit: 1 });
  assert(preview.rows.some((row) => row.key === 'project:tree:session:two'));
  assert(!preview.rows.some((row) => row.key === 'project:tree:session:three'));
  assert(preview.rows.some((row) => row.key === 'project-more:tree'));
  const expanded = projectChatGroups(tree, project, new Set(), true, { previewLimit: 1, expandedProjectIds: new Set(['tree']) });
  assert(expanded.rows.some((row) => row.key === 'project:tree:session:three'));
  assert(!projectChatGroups(tree, project, new Set(), false).limitedProjectIds.size);
});

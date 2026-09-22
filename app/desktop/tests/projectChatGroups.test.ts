import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectChatGroups, projectScopedSidebarSessions } from '../src/features/projects/projectChatGroups';
import type { ChatSidebarRow } from '../src/pages/sidebar/chatSidebarRows';

const rows: ChatSidebarRow[] = ['one', 'two', 'three'].map((id) => ({
  kind: 'session', key: `session:${id}`, sessionId: id, spaceId: 'agent', depth: 0, activePath: id === 'one',
}));
const projects = [{ id: 'app', name: 'App', sessions: [{ id: 'one' }, { id: 'three' }] }];

test('projects group existing sessions without changing identity; collapse also hides the active row', () => {
  const grouped = projectChatGroups(rows, projects, new Set());
  assert.deepEqual(grouped.rows.map((row) => row.key), ['project-group:app', 'session:one', 'session:three', 'project-group:unassigned', 'session:two']);
  assert.strictEqual(grouped.rows[1], rows[0]);
  assert.deepEqual(projectChatGroups(rows, projects, new Set(['app'])).rows.map((row) => row.key), ['project-group:app', 'project-group:unassigned', 'session:two']);
});

test('moving or removing membership keeps every chat discoverable in Recents after projects', () => {
  const moved = [{ id: 'other', name: 'Other', sessions: [{ id: 'two' }] }];
  const grouped = projectChatGroups(rows, moved, new Set());
  assert.equal(grouped.groups.get('unassigned')?.rows.length, 2);
  assert.equal(grouped.groups.get('other')?.rows.length, 1);
  assert.equal(grouped.rows[0].key, 'project-group:other');
  const unassigned = projectChatGroups(rows, [], new Set());
  assert.equal(unassigned.groups.get('unassigned')?.name, 'Recents');
  assert.deepEqual(unassigned.rows.slice(1), rows);
  assert.equal(unassigned.rows[0].key, 'project-group:unassigned');
  assert.deepEqual(projectChatGroups(rows, [], new Set(['unassigned'])).rows.map((row) => row.key), ['project-group:unassigned']);
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
  assert.deepEqual(projectChatGroups(rows, [emptyProject], new Set(), false).rows.slice(1), rows);
});

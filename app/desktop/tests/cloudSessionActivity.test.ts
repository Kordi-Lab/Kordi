import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloneCloudSessionActivityForFork,
  cloudActivityStorageKey,
  cloudArtifactToSessionArtifact,
  cloudArtifactsForSession,
  cloudTaskActivitiesForSession,
  cloudTaskToSessionTaskActivity,
  cloudVisibleTaskRecordsForSession,
  deriveCloudActivityFromTurn,
  mergeCloudSessionActivity,
  normalizeCloudSessionActivitySnapshot,
} from '../src/features/cloud/cloudSessionActivity';

test('mergeCloudSessionActivity keeps newer task and artifact rows by session id', () => {
  const current = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'old', sessionId: 'session:group:1', taskId: 'task-1', title: 'Old', summary: null, status: 'active', createdByAccountId: 'acct_a', targetAccountId: null, participants: [], artifactIds: [], responseMessageId: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null }],
    artifacts: [{ artifactActivityId: 'artifact-old', sessionId: 'session:group:1', artifactId: 'docs/a.md', name: 'a.md', path: 'docs/a.md', kind: 'document', category: 'artifact', summary: null, createdByAccountId: 'acct_a', sourceMessageId: null, attachmentId: null, contentType: null, sizeBytes: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null }],
  });
  const incoming = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'new', sessionId: 'session:group:1', taskId: 'task-1', title: 'New', summary: null, status: 'complete', createdByAccountId: 'acct_a', targetAccountId: null, participants: [], artifactIds: ['docs/a.md'], responseMessageId: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:02:00Z', archivedAt: null }],
    artifacts: [{ artifactActivityId: 'artifact-new', sessionId: 'session:group:1', artifactId: 'docs/a.md', name: 'a.md', path: 'docs/a.md', kind: 'document', category: 'artifact', summary: null, createdByAccountId: 'acct_a', sourceMessageId: null, attachmentId: null, contentType: null, sizeBytes: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:02:00Z', archivedAt: null }],
  });

  const merged = mergeCloudSessionActivity(current, incoming);

  assert.equal(merged.tasksBySessionId['session:group:1']?.[0]?.title, 'New');
  assert.equal(merged.artifactsBySessionId['session:group:1']?.[0]?.artifactActivityId, 'artifact-new');
});

test('mergeCloudSessionActivity preserves identity for the same diff snapshot', () => {
  const current = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'taskact_1', sessionId: 'session:group:1', taskId: 'task-1', title: 'Review', summary: null, status: 'active', createdByAccountId: 'acct_a', targetAccountId: null, participants: [], artifactIds: [], responseMessageId: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null }],
    artifacts: [],
  });
  const repeatedSnapshot = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'taskact_1', sessionId: 'session:group:1', taskId: 'task-1', title: 'Review', summary: null, status: 'active', createdByAccountId: 'acct_a', targetAccountId: null, participants: [], artifactIds: [], responseMessageId: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null }],
    artifacts: [],
  });

  assert.equal(mergeCloudSessionActivity(current, current), current);
  assert.equal(mergeCloudSessionActivity(current, repeatedSnapshot), current);
});

test('cloud task rows adapt to SessionTaskActivity and artifact rows adapt to SessionArtifact', () => {
  const task = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'taskact_1', sessionId: 'session:group:1', taskId: 'task-1', title: 'Review plan', summary: null, status: 'active', createdByAccountId: 'acct_a', targetAccountId: null, participants: [{ accountId: 'acct_a', displayName: 'Alice' }], artifactIds: ['docs/plan.md'], responseMessageId: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:02:00Z', archivedAt: null }],
    artifacts: [],
  }).tasksBySessionId['session:group:1']![0];
  const artifact = normalizeCloudSessionActivitySnapshot({
    tasks: [],
    artifacts: [{ artifactActivityId: 'artifactact_1', sessionId: 'session:group:1', artifactId: 'docs/plan.md', name: 'plan.md', path: 'docs/plan.md', kind: 'document', category: 'artifact', summary: 'Generated plan', createdByAccountId: 'acct_a', sourceMessageId: null, attachmentId: null, contentType: null, sizeBytes: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:02:00Z', archivedAt: null }],
  }).artifactsBySessionId['session:group:1']![0];

  assert.equal(cloudTaskToSessionTaskActivity(task).target?.name, 'Review plan');
  assert.equal(cloudArtifactToSessionArtifact(artifact).id, 'docs/plan.md');
  assert.equal(cloudActivityStorageKey('acct_a'), 'kordi.cloud.sessionActivity.v1:acct_a');
});

test('session helpers return UI activity for a session with dedupe', () => {
  const store = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'taskact_1', sessionId: 'session:group:cloud', taskId: 'task-1', title: 'Review launch plan', summary: null, status: 'active', createdByAccountId: 'acct_a', targetAccountId: null, participants: [], artifactIds: [], responseMessageId: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null }],
    artifacts: [{ artifactActivityId: 'artifactact_1', sessionId: 'session:group:cloud', artifactId: 'docs/a.md', name: 'a.md', path: 'docs/a.md', kind: 'document', category: 'artifact', summary: null, createdByAccountId: 'acct_a', sourceMessageId: null, attachmentId: null, contentType: null, sizeBytes: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null }],
  });

  assert.equal(cloudTaskActivitiesForSession(store, 'session:group:cloud')[0]?.target?.name, 'Review launch plan');
  assert.equal(cloudArtifactsForSession(store, 'session:group:cloud')[0]?.id, 'docs/a.md');
});

test('cloud visible task records expose one shared session task list to native agents', () => {
  const store = normalizeCloudSessionActivitySnapshot({
    tasks: [
      { taskActivityId: 'taskact_open', sessionId: 'session:group:cloud', taskId: 'another_test_task', title: 'Another Test Task', summary: 'Shared follow-up', status: 'active', createdByAccountId: 'acct_a', targetAccountId: null, participants: [{ accountId: 'acct_a', displayName: 'C UFishAI' }, { accountId: 'acct_b', displayName: 'Shu Yang' }], artifactIds: [], responseMessageId: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null },
      { taskActivityId: 'taskact_closed', sessionId: 'session:group:cloud', taskId: 'find_restaurant_options', title: 'Find Restaurant Options', summary: null, status: 'closed', createdByAccountId: 'acct_b', targetAccountId: null, participants: [{ accountId: 'acct_b', displayName: 'Shu Yang' }], artifactIds: [], responseMessageId: null, createdAt: '2026-05-15T09:00:00Z', updatedAt: '2026-05-15T09:05:00Z', archivedAt: null },
      { taskActivityId: 'taskact_other', sessionId: 'session:group:other', taskId: 'other_task', title: 'Other Task', summary: null, status: 'active', createdByAccountId: 'acct_c', targetAccountId: null, participants: [], artifactIds: [], responseMessageId: null, createdAt: '2026-05-15T08:00:00Z', updatedAt: '2026-05-15T08:00:00Z', archivedAt: null },
    ],
    artifacts: [],
  });

  assert.deepEqual(cloudVisibleTaskRecordsForSession(store, 'session:group:cloud'), [
    {
      taskId: 'another_test_task',
      parentTaskId: null,
      title: 'Another Test Task',
      summary: 'Shared follow-up',
      status: 'open',
      involvedParticipants: ['C UFishAI', 'Shu Yang'],
    },
    {
      taskId: 'find_restaurant_options',
      parentTaskId: null,
      title: 'Find Restaurant Options',
      summary: null,
      status: 'closed',
      involvedParticipants: ['Shu Yang'],
    },
  ]);
});

test('deriveCloudActivityFromTurn extracts task_operator tasks and generated artifacts', () => {
  const derived = deriveCloudActivityFromTurn({
    sessionId: 'session:group:cloud',
    localAccountId: 'acct_me',
    participantAccountIds: ['acct_me', 'acct_peer'],
    turn: {
      id: 'turn_1', sessionId: 'session:group:cloud', prompt: 'make a plan', status: 'complete', message: 'done', assistantText: 'Done', thinkingText: '', completed: true, succeeded: true, error: null, transcriptRefreshRequired: false, startedAtMs: 1, completedAtMs: 2,
      tools: [
        { id: 'tool_1', name: 'task_operator', status: 'done', arguments: JSON.stringify({ taskId: 'launch_plan', taskTitle: 'Launch plan', action: 'create' }), liveOutput: '', resultText: 'Task created', detail: null, artifactPath: null, toolLayer: null, isError: false },
        { id: 'tool_2', name: 'write', status: 'done', arguments: JSON.stringify({ path: 'docs/launch-plan.md' }), liveOutput: '', resultText: 'ok', detail: null, artifactPath: 'docs/launch-plan.md', toolLayer: null, isError: false },
      ],
    },
  });

  assert.equal(derived.tasks[0]?.taskId, 'launch_plan');
  assert.equal(derived.tasks[0]?.status, 'active');
  assert.equal(derived.artifacts[0]?.artifactId, 'docs/launch-plan.md');
});

test('deriveCloudActivityFromTurn ignores context-wrapper task_operator rows without explicit task identity', () => {
  const derived = deriveCloudActivityFromTurn({
    sessionId: 'session:direct-person:a:b',
    localAccountId: 'acct_me',
    participantAccountIds: ['acct_me', 'acct_peer'],
    turn: {
      id: 'turn_1',
      sessionId: 'session:direct-person:a:b',
      prompt: 'Use the shared Cloud conversation below as the single context window. Current request from C UFishAI: close all the task here',
      status: 'complete',
      message: 'Closed all tasks I can access here.',
      assistantText: 'Closed all tasks I can access here.',
      thinkingText: '',
      completed: true,
      succeeded: true,
      error: null,
      transcriptRefreshRequired: false,
      startedAtMs: 1,
      completedAtMs: 2,
      tools: [
        { id: 'tool_1', name: 'task_operator', status: 'done', arguments: JSON.stringify({ action: 'close' }), liveOutput: '', resultText: 'Closed all tasks I can access here.', detail: null, artifactPath: null, toolLayer: null, isError: false },
      ],
    },
  });

  assert.equal(derived.tasks.length, 0);
});

test('deriveCloudActivityFromTurn ignores failed task_operator updates instead of mutating Cloud task state', () => {
  const derived = deriveCloudActivityFromTurn({
    sessionId: 'session:direct-person:a:b',
    localAccountId: 'acct_me',
    participantAccountIds: ['acct_me', 'acct_peer'],
    turn: {
      id: 'turn_1',
      sessionId: 'session:direct-person:a:b',
      prompt: '@MyKordi finish this task Another Test Task',
      status: 'complete',
      message: 'I couldn’t finish **Another Test Task** because it’s already closed or no longer open here.',
      assistantText: 'I couldn’t finish **Another Test Task** because it’s already closed or no longer open here.',
      thinkingText: '',
      completed: true,
      succeeded: true,
      error: null,
      transcriptRefreshRequired: false,
      startedAtMs: 1,
      completedAtMs: 2,
      tools: [
        { id: 'tool_1', name: 'task_operator', status: 'failed', arguments: JSON.stringify({ action: 'close', taskTitle: 'Another Test Task' }), liveOutput: '', resultText: 'I couldn’t finish **Another Test Task** because it’s already closed or no longer open here.', detail: null, artifactPath: null, toolLayer: null, isError: true },
      ],
    },
  });

  assert.equal(derived.tasks.length, 0);
});

test('deriveCloudActivityFromTurn preserves participant display names and avatars', () => {
  const derived = deriveCloudActivityFromTurn({
    sessionId: 'session:group:cloud',
    localAccountId: 'acct_me',
    participantAccountIds: ['acct_me', 'acct_peer'],
    participantProfiles: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: 'https://example.test/me.png' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: 'https://example.test/peer.png' },
    ],
    turn: {
      id: 'turn_1', sessionId: 'session:group:cloud', prompt: 'make a task', status: 'complete', message: 'done', assistantText: 'Done', thinkingText: '', completed: true, succeeded: true, error: null, transcriptRefreshRequired: false, startedAtMs: 1, completedAtMs: 2,
      tools: [
        { id: 'tool_1', name: 'task_operator', status: 'done', arguments: JSON.stringify({ taskId: 'task_1', taskTitle: 'Task one', action: 'create' }), liveOutput: '', resultText: 'Task created', detail: null, artifactPath: null, toolLayer: null, isError: false },
      ],
    },
  });

  assert.deepEqual(derived.tasks[0]?.participants, [
    { accountId: 'acct_me', displayName: 'Me', avatarUrl: 'https://example.test/me.png' },
    { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: 'https://example.test/peer.png' },
  ]);
});

test('cloneCloudSessionActivityForFork copies source tasks and artifacts to fork session', () => {
  const source = normalizeCloudSessionActivitySnapshot({
    tasks: [{ taskActivityId: 'taskact_1', sessionId: 'session:group:parent', taskId: 'task-1', title: 'Review', summary: null, status: 'active', createdByAccountId: 'acct_a', targetAccountId: null, participants: [], artifactIds: ['docs/a.md'], responseMessageId: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null }],
    artifacts: [{ artifactActivityId: 'artifactact_1', sessionId: 'session:group:parent', artifactId: 'docs/a.md', name: 'a.md', path: 'docs/a.md', kind: 'document', category: 'artifact', summary: null, createdByAccountId: 'acct_a', sourceMessageId: null, attachmentId: null, contentType: null, sizeBytes: null, createdAt: '2026-05-15T10:00:00Z', updatedAt: '2026-05-15T10:00:00Z', archivedAt: null }],
  });

  const cloned = cloneCloudSessionActivityForFork(source, 'session:group:parent', 'session:fork:child', '2026-05-15T10:05:00Z');

  assert.equal(cloned.tasksBySessionId['session:fork:child']?.[0]?.sessionId, 'session:fork:child');
  assert.equal(cloned.artifactsBySessionId['session:fork:child']?.[0]?.sessionId, 'session:fork:child');
});

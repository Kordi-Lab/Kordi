import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  DesktopChatMessage,
  DesktopChatProjectGroup,
  DesktopChatSessionDetail,
  DesktopChatSessionSummary,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  Message,
  QueuedDesktopChatMessage,
} from '../src/kordi-app/types';
import {
  appendDesktopSessionSourceMessageToCache,
  appendMappedSessionMessageToCache,
  mergeDesktopSessionSourceMessagesCache,
  mergeLatestDesktopChatState,
  mergeMappedSessionMessagesCache,
  recentDesktopSessionIds,
  pruneDesktopSessionCacheByKnownSessions,
  pruneDesktopLiveTurnsByKnownSessions,
  pruneLocalSessionUnreadCounts,
  pruneQueuedDesktopMessagesByKnownSessions,
} from '../src/features/chat/desktopChatStateReducers';

test('recent desktop transcripts stay bounded and promote cache hits', () => {
  let recent: readonly string[] = [];
  for (let index = 0; index < 10; index += 1) {
    recent = recentDesktopSessionIds(recent, `session-${index}`);
  }
  assert.deepEqual(recent, [
    'session-2',
    'session-3',
    'session-4',
    'session-5',
    'session-6',
    'session-7',
    'session-8',
    'session-9',
  ]);
  assert.deepEqual(recentDesktopSessionIds(recent, 'session-4'), [
    'session-2',
    'session-3',
    'session-5',
    'session-6',
    'session-7',
    'session-8',
    'session-9',
    'session-4',
  ]);
});

function session(overrides: Partial<DesktopChatSessionSummary> = {}): DesktopChatSessionSummary {
  return {
    id: 'session-a',
    title: 'Session A',
    subtitle: 'old subtitle',
    updatedAtLabel: '10:00',
    updatedAtMs: 1,
    messageCount: 2,
    draft: false,
    ...overrides,
  };
}

function activeSession(overrides: Partial<DesktopChatSessionDetail> = {}): DesktopChatSessionDetail {
  return {
    id: 'session-a',
    title: 'Session A',
    subtitle: 'old subtitle',
    provider: 'provider',
    providerLabel: 'Provider',
    model: 'model',
    modelLabel: 'Model',
    thinking: 'auto',
    thinkingLabel: 'Auto',
    thinkingLevels: [],
    updatedAtLabel: '10:00',
    updatedAtMs: 1,
    messageCount: 2,
    draft: false,
    contextWindowText: '0%',
    contextWindowStatus: { contextWindow: 0, autoCompaction: false },
    messages: [desktopMessage('one'), desktopMessage('two')],
    ...overrides,
  };
}

function project(overrides: Partial<DesktopChatProjectGroup> = {}): DesktopChatProjectGroup {
  return {
    id: 'project-a',
    name: 'Project A',
    root: '/project',
    summary: 'Project',
    sharedSources: [],
    sessions: [session()],
    ...overrides,
  };
}

function desktopMessage(text: string): DesktopChatMessage {
  return {
    role: 'assistant',
    text,
    timeLabel: '10:00',
    timestampMs: 1,
  };
}

function desktopState(overrides: Partial<DesktopChatState> = {}): DesktopChatState {
  return {
    cwd: '/repo',
    activeSessionId: 'session-a',
    sessions: [session()],
    projects: [project()],
    activeSession: activeSession(),
    localAgent: {
      label: 'My Kordi',
      systemPrompt: '',
      loadedSkills: [],
      loadedTools: [],
      loadedPlugins: [],
      identityFiles: [],
      defaultProvider: 'provider',
      defaultModel: 'model',
      workspaceRoot: '/repo',
      lastActivities: [],
    },
    modelOptions: [],
    slashCommands: [],
    ...overrides,
  };
}

function liveTurn(overrides: Partial<DesktopChatTurnSnapshot> = {}): DesktopChatTurnSnapshot {
  return {
    id: 'turn-1',
    sessionId: 'session-a',
    prompt: 'hello',
    status: 'running',
    message: '',
    assistantText: '',
    thinkingText: '',
    tools: [],
    completed: false,
    succeeded: false,
    ...overrides,
  };
}

function queuedMessage(overrides: Partial<QueuedDesktopChatMessage> = {}): QueuedDesktopChatMessage {
  return {
    id: 'queued-1',
    sessionId: 'session-a',
    scope: 'chat',
    text: 'queued text',
    time: '10:01',
    attachments: [],
    ...overrides,
  };
}

test('mergeLatestDesktopChatState preserves inactive session rows during transient partial refresh', () => {
  const current = desktopState({
    sessions: [
      session({ id: 'session-a', title: 'Session A', updatedAtLabel: '10:05', messageCount: 3 }),
      session({ id: 'session-b', title: 'Session B', updatedAtLabel: '10:03', messageCount: 8 }),
      session({ id: 'session-c', title: 'Session C', updatedAtLabel: '10:01', messageCount: 5 }),
    ],
  });
  const refreshed = desktopState({
    sessions: [
      session({ id: 'session-a', title: 'Session A refreshed', updatedAtLabel: '10:06', messageCount: 4 }),
    ],
    activeSession: activeSession({
      id: 'session-a',
      title: 'Session A refreshed',
      updatedAtLabel: '10:06',
      messageCount: 4,
      messages: [desktopMessage('one'), desktopMessage('two'), desktopMessage('three'), desktopMessage('four')],
    }),
  });

  const merged = mergeLatestDesktopChatState(current, refreshed, false);

  assert.deepEqual(merged.sessions.map((item) => item.id), ['session-a', 'session-b', 'session-c']);
  assert.equal(merged.sessions[0].title, 'Session A refreshed');
  assert.equal(merged.sessions[1].title, 'Session B');
});

test('mergeLatestDesktopChatState preserves richer active transcript during live-turn refresh', () => {
  const current = desktopState({
    activeSession: activeSession({
      subtitle: 'streaming preview',
      updatedAtLabel: '10:05',
      messageCount: 3,
      messages: [desktopMessage('one'), desktopMessage('two'), desktopMessage('streaming')],
    }),
    sessions: [session({ subtitle: 'streaming preview', updatedAtLabel: '10:05', messageCount: 3 })],
    projects: [project({ sessions: [session({ subtitle: 'streaming preview', updatedAtLabel: '10:05', messageCount: 3 })] })],
  });
  const refreshed = desktopState({
    activeSession: activeSession({
      subtitle: 'older preview',
      updatedAtLabel: '10:04',
      messageCount: 2,
      messages: [desktopMessage('one'), desktopMessage('two')],
    }),
    sessions: [session({ subtitle: 'older preview', updatedAtLabel: '10:04', messageCount: 2 })],
    projects: [project({ sessions: [session({ subtitle: 'older preview', updatedAtLabel: '10:04', messageCount: 2 })] })],
  });

  const merged = mergeLatestDesktopChatState(current, refreshed, true);

  assert.equal(merged.activeSession.subtitle, 'streaming preview');
  assert.equal(merged.activeSession.updatedAtLabel, '10:05');
  assert.equal(merged.activeSession.messageCount, 3);
  assert.deepEqual(merged.activeSession.messages.map((message) => message.text), ['one', 'two', 'streaming']);
  assert.equal(merged.sessions[0].subtitle, 'streaming preview');
  assert.equal(merged.sessions[0].messageCount, 3);
  assert.equal(merged.projects[0].sessions[0].updatedAtLabel, '10:05');
});

test('prune refresh-scoped desktop stores keeps only known visible-safe records', () => {
  const knownSessionIds = new Set(['session-a', 'session-b']);
  assert.deepEqual(
    pruneLocalSessionUnreadCounts({ 'session-a': 2, 'session-b': 1, 'session-gone': 3, 'session-zero': 0 }, knownSessionIds, 'session-b'),
    { 'session-a': 2 },
  );

  assert.deepEqual(
    pruneDesktopLiveTurnsByKnownSessions({
      'session-a': liveTurn(),
      'session-b': liveTurn({ sessionId: 'session-b', completed: true }),
      'session-gone': liveTurn({ sessionId: 'session-gone' }),
    }, knownSessionIds),
    { 'session-a': liveTurn() },
  );

  assert.deepEqual(
    pruneQueuedDesktopMessagesByKnownSessions({
      'session-a': [queuedMessage()],
      'session-b': [],
      'session-gone': [queuedMessage({ id: 'queued-gone', sessionId: 'session-gone' })],
    }, knownSessionIds),
    { 'session-a': [queuedMessage()] },
  );

  const cachedA = [desktopMessage('cached')];
  assert.deepEqual(
    pruneDesktopSessionCacheByKnownSessions({
      'session-a': cachedA,
      'session-gone': [desktopMessage('gone')],
    }, knownSessionIds),
    { 'session-a': cachedA },
  );
});

test('mergeMappedSessionMessagesCache preserves longer cached transcript while a live turn is visible', () => {
  const existing: Message[] = [
    { role: 'user', text: 'hello', time: '10:00' },
    { role: 'owned-agent', text: 'streaming answer', time: '10:01' },
  ];
  const mapped: Message[] = [
    { role: 'user', text: 'hello', time: '10:00' },
  ];

  const preserved = mergeMappedSessionMessagesCache({ 'session-a': existing }, 'session-a', mapped, true);
  assert.equal(preserved['session-a'], existing);

  const replaced = mergeMappedSessionMessagesCache({ 'session-a': existing }, 'session-a', mapped, false);
  assert.equal(replaced['session-a'], mapped);
});

test('completed turn appends to a hydrated cache even when that session is not the desktop active session', () => {
  const existing: Message[] = [
    { id: 'msg-user', role: 'user', text: 'hello', time: '10:00' },
  ];
  const failedReply: Message = {
    id: 'msg-provider-error',
    role: 'owned-agent',
    text: 'Provider error',
    time: '10:01',
  };
  const current = {
    'session-a': [{ role: 'user' as const, text: 'another session', time: '09:59' }],
    'session-visible': existing,
  };

  const appended = appendMappedSessionMessageToCache(current, 'session-visible', failedReply);
  assert.deepEqual(appended['session-visible'], [...existing, failedReply]);
  assert.equal(appended['session-a'], current['session-a']);

  const deduped = appendMappedSessionMessageToCache(appended, 'session-visible', failedReply);
  assert.equal(deduped, appended);
});

test('raw desktop transcript cache stays stable during a shorter live snapshot and accepts the completed source row', () => {
  const first = desktopMessage('one');
  const streaming = { ...desktopMessage('streaming'), transcriptRenderId: 'turn-streaming' };
  const existing = [first, streaming];

  const preserved = mergeDesktopSessionSourceMessagesCache(
    { 'session-a': existing },
    'session-a',
    [first],
    true,
  );
  assert.equal(preserved['session-a'], existing);

  const completed = { ...desktopMessage('complete'), transcriptRenderId: 'turn-complete' };
  const appended = appendDesktopSessionSourceMessageToCache(preserved, 'session-a', completed);
  assert.deepEqual(appended['session-a'], [...existing, completed]);

  const deduped = appendDesktopSessionSourceMessageToCache(appended, 'session-a', structuredClone(completed));
  assert.equal(deduped, appended);
});

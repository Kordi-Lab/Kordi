import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatDetailPanel, chatArtifactPreviewBaseRoot } from '../src/pages/ChatDetailPanel';

const baseOutreach = {
  targetKind: 'person',
  parentSessionId: 'session:group:88bbd974-b87f-4e04-a9dc-40c4c9bf1af7',
  sourceHostId: 'bridge-host-1',
  sourceRequestId: 'bridge-request-1',
  targetNodeId: 'kd_remote',
  targetHumanId: 'human-remote',
  targetDisplayName: 'Kordi User 3',
  targetOwnerName: 'Kordi User 3',
  requestText: 'NLP/AI conference deadlines',
  contextPolicy: 'session-message',
  status: 'complete',
  createdAtMs: 1_000,
  updatedAtMs: 2_000,
};

test('chat artifact previews use the active local session cwd when no project root is available', () => {
  assert.equal(chatArtifactPreviewBaseRoot({
    activeConversationUsesCollaboration: false,
    activeSessionProjectRoot: null,
    activeSessionWorkspaceRoot: '/tmp/session-cwd',
  }), '/tmp/session-cwd');
});

test('chat artifact previews prefer the project root and avoid local roots for bridge conversations', () => {
  assert.equal(chatArtifactPreviewBaseRoot({
    activeConversationUsesCollaboration: false,
    activeSessionProjectRoot: '/tmp/project-root',
    activeSessionWorkspaceRoot: '/tmp/session-cwd',
  }), '/tmp/project-root');
  assert.equal(chatArtifactPreviewBaseRoot({
    activeConversationUsesCollaboration: true,
    activeSessionProjectRoot: '/tmp/project-root',
    activeSessionWorkspaceRoot: '/tmp/session-cwd',
  }), null);
});

function renderInfoPanel(overrides = {}) {
  return renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'info',
    activeConv: {
      id: 'session:group:weekend-plan',
      canonicalSessionId: 'session:group:weekend-plan',
      name: 'Weekend plan',
      type: 'person',
      subtitle: 'session:group:weekend-plan',
      unread: 0,
      collaborationSources: ['Bridge'],
      trust: 'Owned',
      directness: 'Group chat',
      participants: ['Me', 'Testuser5', 'Testuser4'],
      messages: [],
      ...overrides,
    },
    activeConvHasSubtitle: true,
    activeLastMessage: { time: '13:58', text: 'Latest update' },
    activeConversationUsesCollaboration: true,
    activeCollaborationConversationHostNodeId: 'kd_local',
    activeCollaborationConversationHostUrl: 'https://bridge.example.test',
    activeCollaborationConversation: {
      peerNodeId: 'kd_remote',
      peerRuntime: 'desktop',
      projectName: null,
      projectId: null,
      title: 'Weekend plan',
      peerTyping: false,
    },
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
    onOpenOutreachThread: () => {},
  }));
}

test('chat detail panel keeps outreach threads out of the normal info view', () => {
  const markup = renderInfoPanel({
    outreachThreads: [{
      id: 'desktop-bridge-outreach:thread-1',
      title: 'Testuser5',
      targetDisplayName: 'Testuser5',
      targetKind: 'person',
      subtitle: 'Internal outreach copy',
      status: 'completed',
      updatedAtLabel: '13:58',
    }],
  });

  assert.match(markup, /Weekend plan/);
  assert.doesNotMatch(markup, /Outreach threads/);
  assert.doesNotMatch(markup, /Internal outreach copy/);
});

test('chat detail task panel renders model-created task rows, not simple delegation rows', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:group:weekend-plan',
      canonicalSessionId: 'session:group:weekend-plan',
      name: 'Weekend plan',
      type: 'person',
      subtitle: 'session:group:weekend-plan',
      unread: 0,
      collaborationSources: ['Bridge'],
      trust: 'Bridge',
      directness: 'Group chat',
      participants: ['Me', 'Alice', 'Remote Kordi'],
      messages: [{
        id: 'msg:remote-agent-task-response',
        role: 'external-agent',
        sender: 'Remote Kordi',
        senderType: 'agent',
        isOwnMessage: false,
        showSenderMeta: true,
        text: '',
        time: '13:58',
        turn: {
          id: 'turn:remote-agent-task-response',
          sessionId: 'session:group:weekend-plan',
          prompt: '',
          status: 'complete',
          message: 'Complete',
          assistantText: 'Done — I created a temporary test task for us and marked it complete.',
          thinkingText: '',
          tools: [{
            id: 'tool:task-operator',
            name: 'task_operator',
            status: 'done',
            arguments: JSON.stringify({ taskTitle: 'Temporary Test Task', plan: [{ step: 'Create temporary test task', status: 'completed' }] }),
            liveOutput: '',
            resultText: 'Done',
            detail: null,
            artifactPath: null,
            toolLayer: null,
            isError: false,
          }],
          completed: true,
          succeeded: true,
          error: null,
        },
      }],
      taskActivities: [{
        id: 'delegation:1',
        sessionId: 'session:group:weekend-plan',
        status: 'processing',
        initiator: { id: 'human:me', name: 'Me', kind: 'human', role: 'self', avatarKey: 'me' },
        target: { id: 'agent:remote', name: 'Remote Kordi', kind: 'agent', role: 'external-agent', avatarKey: 'remote-agent' },
        participants: [
          { id: 'human:me', name: 'Me', kind: 'human', role: 'self', avatarKey: 'me' },
          { id: 'human:alice', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'alice' },
          { id: 'agent:remote', name: 'Remote Kordi', kind: 'agent', role: 'external-agent', avatarKey: 'remote-agent' },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
        sourceConversationId: 'bridge:host:remote-agent',
        sourceRequestId: 'bridge_req_task',
        contextPolicy: 'session-message',
      }],
    },
    activeConvHasSubtitle: true,
    activeLastMessage: { time: '13:58', text: 'Latest update' },
    activeConversationUsesCollaboration: false,
    activeCollaborationConversationHostNodeId: null,
    activeCollaborationConversationHostUrl: null,
    activeCollaborationConversation: null,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.match(markup, /Temporary Test Task/);
  assert.match(markup, /data-task-action="jump-response"/);
  assert.doesNotMatch(markup, /Remote Kordi<\/div><div class="mt-1 app-inspector-text-block">Running/);
  assert.doesNotMatch(markup, /Delegated by Me/);
  assert.doesNotMatch(markup, /Shared with 3 participants/);
});

test('chat detail task panel renders Cloud-synced task activity rows', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:group:cloud',
      canonicalSessionId: 'session:group:cloud',
      name: 'Cloud group',
      type: 'person',
      subtitle: '',
      unread: 0,
      collaborationSources: ['Cloud'],
      trust: 'Cloud',
      directness: 'Group chat',
      participants: ['Me'],
      messages: [],
      taskActivities: [{
        id: 'cloud-task:task-1',
        sessionId: 'session:group:cloud',
        status: 'active',
        initiator: { id: 'cloud:acct_a', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_a' },
        target: { id: 'task:task-1', name: 'Review launch plan', kind: 'agent', role: 'external-agent', avatarKey: 'acct_a' },
        participants: [],
        createdAtMs: 1,
        updatedAtMs: 2,
        contextPolicy: 'cloud-session-activity',
      }],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
    activeConversationUsesCollaboration: true,
    activeCollaborationConversationHostNodeId: null,
    activeCollaborationConversationHostUrl: null,
    activeCollaborationConversation: null,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.match(markup, /Review launch plan/);
});

test('chat detail task panel dedupes Cloud activity that mirrors a local task_operator turn', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:direct-person:acct_a:acct_b',
      canonicalSessionId: 'session:direct-person:acct_a:acct_b',
      name: 'Alice',
      type: 'person',
      subtitle: '',
      unread: 0,
      collaborationSources: ['Cloud'],
      trust: 'Cloud',
      directness: 'Direct person chat',
      participants: ['Me', 'Alice'],
      messages: [{
        id: 'msg:agent-task-response',
        role: 'external-agent',
        sender: 'Alice Kordi',
        senderType: 'agent',
        isOwnMessage: false,
        showSenderMeta: true,
        text: '',
        time: '18:04',
        turn: {
          id: 'turn:agent-task-response',
          sessionId: 'session:direct-person:acct_a:acct_b',
          prompt: '@MyKordi create task',
          status: 'complete',
          message: 'Created the task: Cloud Duplicate Task',
          assistantText: 'Created the task: Cloud Duplicate Task',
          thinkingText: '',
          tools: [{
            id: 'tool:task-operator',
            name: 'task_operator',
            status: 'done',
            arguments: JSON.stringify({ taskId: 'task_123', taskTitle: 'Cloud Duplicate Task', action: 'create' }),
            liveOutput: '',
            resultText: 'Task ID: `task_123`',
            detail: null,
            artifactPath: null,
            toolLayer: null,
            isError: false,
          }],
          completed: true,
          succeeded: true,
          error: null,
        },
      }],
      taskActivities: [{
        id: 'cloud-task:session:direct-person:acct_a:acct_b:task_123',
        sessionId: 'session:direct-person:acct_a:acct_b',
        status: 'active',
        initiator: { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b' },
        target: { id: 'task:task_123', name: 'Cloud Duplicate Task', kind: 'agent', role: 'external-agent', avatarKey: 'acct_b' },
        participants: [{ id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b' }],
        createdAtMs: 1,
        updatedAtMs: 2,
        sourceRequestId: 'task_123',
        contextPolicy: 'cloud-session-activity',
      }],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
    activeConversationUsesCollaboration: true,
    activeCollaborationConversationHostNodeId: null,
    activeCollaborationConversationHostUrl: null,
    activeCollaborationConversation: null,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.equal(markup.match(/app-inspector-source-row/g)?.length, 1);
});

test('chat detail task panel prefers Cloud task activity over failed local task_operator rows with the same title', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:direct-person:acct_a:acct_b',
      canonicalSessionId: 'session:direct-person:acct_a:acct_b',
      name: 'Alice',
      type: 'person',
      subtitle: '',
      unread: 0,
      collaborationSources: ['Cloud'],
      trust: 'Cloud',
      directness: 'Direct person chat',
      participants: ['Me', 'Alice'],
      messages: [{
        id: 'msg:failed-close',
        role: 'external-agent',
        sender: 'Alice Kordi',
        senderType: 'agent',
        isOwnMessage: false,
        showSenderMeta: true,
        text: '',
        time: '18:49',
        turn: {
          id: 'turn:failed-close',
          sessionId: 'session:direct-person:acct_a:acct_b',
          prompt: '@MyKordi finish this task Another Test Task',
          status: 'complete',
          message: 'I couldn’t finish Another Test Task because it is already closed.',
          assistantText: 'I couldn’t finish Another Test Task because it is already closed.',
          thinkingText: '',
          tools: [{
            id: 'tool:task-operator',
            name: 'task_operator',
            status: 'failed',
            arguments: JSON.stringify({ taskTitle: 'Another Test Task', action: 'close' }),
            liveOutput: '',
            resultText: 'I couldn’t finish Another Test Task because it is already closed.',
            detail: null,
            artifactPath: null,
            toolLayer: null,
            isError: true,
          }],
          completed: true,
          succeeded: true,
          error: null,
        },
      }],
      taskActivities: [{
        id: 'cloud-task:session:direct-person:acct_a:acct_b:another_test_task',
        sessionId: 'session:direct-person:acct_a:acct_b',
        status: 'active',
        initiator: { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b', profileImageUrl: 'https://example.test/alice.png' },
        target: { id: 'task:another_test_task', name: 'Another Test Task', kind: 'agent', role: 'external-agent', avatarKey: 'acct_b' },
        participants: [
          { id: 'cloud:acct_a', name: 'Me', kind: 'human', role: 'self', avatarKey: 'acct_a', profileImageUrl: 'https://example.test/me.png' },
          { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b', profileImageUrl: 'https://example.test/alice.png' },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
        sourceRequestId: 'another_test_task',
        contextPolicy: 'cloud-session-activity',
      }],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
    activeConversationUsesCollaboration: true,
    activeCollaborationConversationHostNodeId: null,
    activeCollaborationConversationHostUrl: null,
    activeCollaborationConversation: null,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.equal(markup.match(/app-inspector-source-row/g)?.length, 1);
  assert.match(markup, /Synced Cloud task by Alice/);
  assert.doesNotMatch(markup, /failed subtask/);
  assert.match(markup, /https:\/\/example\.test\/me\.png/);
  assert.match(markup, /https:\/\/example\.test\/alice\.png/);
});

test('chat detail task panel dedupes stale Cloud task rows with the same title and prefers the latest row', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:direct-person:acct_a:acct_b',
      canonicalSessionId: 'session:direct-person:acct_a:acct_b',
      name: 'Alice',
      type: 'person',
      subtitle: '',
      unread: 0,
      collaborationSources: ['Cloud'],
      trust: 'Cloud',
      directness: 'Direct person chat',
      participants: ['Me', 'Alice'],
      messages: [],
      taskActivities: [
        {
          id: 'cloud-task:session:direct-person:acct_a:acct_b:task_new',
          sessionId: 'session:direct-person:acct_a:acct_b',
          status: 'closed',
          initiator: { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b' },
          target: { id: 'task:task_new', name: 'Another Test Task', kind: 'agent', role: 'external-agent', avatarKey: 'acct_b' },
          participants: [{ id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b' }],
          createdAtMs: 3,
          updatedAtMs: 4,
          sourceRequestId: 'task_new',
          contextPolicy: 'cloud-session-activity',
        },
        {
          id: 'cloud-task:session:direct-person:acct_a:acct_b:legacy_slug',
          sessionId: 'session:direct-person:acct_a:acct_b',
          status: 'active',
          initiator: { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b' },
          target: { id: 'task:legacy_slug', name: 'Another Test Task', kind: 'agent', role: 'external-agent', avatarKey: 'acct_b' },
          participants: [{ id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b' }],
          createdAtMs: 1,
          updatedAtMs: 2,
          sourceRequestId: 'legacy_slug',
          contextPolicy: 'cloud-session-activity',
        },
      ],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
    activeConversationUsesCollaboration: true,
    activeCollaborationConversationHostNodeId: null,
    activeCollaborationConversationHostUrl: null,
    activeCollaborationConversation: null,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.equal(markup.match(/app-inspector-source-row/g)?.length, 1);
  assert.match(markup, /lucide-circle-check/);
  assert.doesNotMatch(markup, /Active/);
});

test('chat detail task panel uses canonical Cloud participant avatars for account-id task participants', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:direct-person:acct_a:acct_b',
      canonicalSessionId: 'session:direct-person:acct_a:acct_b',
      name: 'Alice',
      type: 'person',
      subtitle: '',
      unread: 0,
      collaborationSources: ['Cloud'],
      trust: 'Cloud',
      directness: 'Direct person chat',
      participants: ['Me', 'Alice'],
      canonicalParticipants: [{
        id: 'cloud:acct_b',
        name: 'Alice',
        kind: 'human',
        role: 'person',
        avatarKey: 'acct_b',
        profileImageUrl: 'https://example.test/alice.png',
      }],
      messages: [],
      taskActivities: [{
        id: 'cloud-task:session:direct-person:acct_a:acct_b:task_123',
        sessionId: 'session:direct-person:acct_a:acct_b',
        status: 'active',
        initiator: { id: 'cloud:acct_b', name: 'acct_b', kind: 'human', role: 'person', avatarKey: 'acct_b' },
        target: { id: 'task:task_123', name: 'Use Real Avatar', kind: 'agent', role: 'external-agent', avatarKey: 'acct_b' },
        participants: [{ id: 'cloud:acct_b', name: 'acct_b', kind: 'human', role: 'person', avatarKey: 'acct_b' }],
        createdAtMs: 1,
        updatedAtMs: 2,
        sourceRequestId: 'task_123',
        contextPolicy: 'cloud-session-activity',
      }],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
    activeConversationUsesCollaboration: true,
    activeCollaborationConversationHostNodeId: null,
    activeCollaborationConversationHostUrl: null,
    activeCollaborationConversation: null,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.match(markup, /https:\/\/example\.test\/alice\.png/);
  assert.match(markup, /Synced Cloud task by Alice/);
});

test('chat detail task panel prefers Cloud task participant Google avatars over stale canonical pixels', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:direct-person:acct_a:acct_b',
      canonicalSessionId: 'session:direct-person:acct_a:acct_b',
      name: 'Alice',
      type: 'person',
      subtitle: '',
      unread: 0,
      collaborationSources: ['Cloud'],
      trust: 'Cloud',
      directness: 'Direct person chat',
      participants: ['Me', 'Alice'],
      canonicalParticipants: [
        { id: 'cloud:acct_a', name: 'Me', kind: 'human', role: 'self', avatarKey: 'acct_a', profileImageUrl: null },
        { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b', profileImageUrl: null },
      ],
      messages: [],
      taskActivities: [{
        id: 'cloud-task:session:direct-person:acct_a:acct_b:find_restaurant_options',
        sessionId: 'session:direct-person:acct_a:acct_b',
        status: 'complete',
        initiator: { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b', profileImageUrl: 'https://example.test/alice.png' },
        target: { id: 'task:find_restaurant_options', name: 'Find Restaurant Options', kind: 'agent', role: 'external-agent', avatarKey: 'acct_b' },
        participants: [
          { id: 'cloud:acct_a', name: 'Me', kind: 'human', role: 'self', avatarKey: 'acct_a', profileImageUrl: 'https://example.test/me.png' },
          { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b', profileImageUrl: 'https://example.test/alice.png' },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
        sourceRequestId: 'find_restaurant_options',
        contextPolicy: 'cloud-session-activity',
      }],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
    activeConversationUsesCollaboration: true,
    activeCollaborationConversationHostNodeId: null,
    activeCollaborationConversationHostUrl: null,
    activeCollaborationConversation: null,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.match(markup, /https:\/\/example\.test\/me\.png/);
  assert.match(markup, /https:\/\/example\.test\/alice\.png/);
});

test('chat detail task panel shows only the two real Cloud participant avatars for a shared direct task', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:direct-person:acct_a:acct_b',
      canonicalSessionId: 'session:direct-person:acct_a:acct_b',
      name: 'Alice',
      type: 'person',
      subtitle: '',
      unread: 0,
      collaborationSources: ['Cloud'],
      trust: 'Cloud',
      directness: 'Direct person chat',
      participants: ['Me', 'Alice'],
      canonicalParticipants: [
        { id: 'cloud:acct_a', name: 'Me', kind: 'human', role: 'self', avatarKey: 'acct_a', profileImageUrl: 'https://example.test/me.png' },
        { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b', profileImageUrl: 'https://example.test/alice.png' },
      ],
      messages: [],
      taskActivities: [{
        id: 'cloud-task:session:direct-person:acct_a:acct_b:find_restaurant_options',
        sessionId: 'session:direct-person:acct_a:acct_b',
        status: 'complete',
        initiator: { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b', profileImageUrl: 'https://example.test/alice.png' },
        target: { id: 'task:find_restaurant_options', name: 'Find Restaurant Options', kind: 'agent', role: 'external-agent', avatarKey: 'acct_b' },
        participants: [
          { id: 'cloud:acct_a', name: 'Me', kind: 'human', role: 'self', avatarKey: 'acct_a', profileImageUrl: 'https://example.test/me.png' },
          { id: 'cloud:acct_b', name: 'Alice', kind: 'human', role: 'person', avatarKey: 'acct_b', profileImageUrl: 'https://example.test/alice.png' },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
        sourceRequestId: 'find_restaurant_options',
        contextPolicy: 'cloud-session-activity',
      }],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
    activeConversationUsesCollaboration: true,
    activeCollaborationConversationHostNodeId: null,
    activeCollaborationConversationHostUrl: null,
    activeCollaborationConversation: null,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.equal(markup.match(/data-avatar-kind="human"/g)?.length, 2);
  assert.match(markup, /https:\/\/example\.test\/me\.png/);
  assert.match(markup, /https:\/\/example\.test\/alice\.png/);
  assert.match(markup, /lucide-circle /);
  assert.doesNotMatch(markup, /lucide-circle-check/);
});

test('chat detail task panel renders empty task state', () => {
  const markup = renderToStaticMarkup(createElement(ChatDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeConv: {
      id: 'session:group:empty',
      canonicalSessionId: 'session:group:empty',
      name: 'Empty group',
      type: 'person',
      subtitle: '',
      unread: 0,
      collaborationSources: ['Bridge'],
      trust: 'Bridge',
      directness: 'Group chat',
      participants: ['Me'],
      messages: [],
      taskActivities: [],
    },
    activeConvHasSubtitle: false,
    activeLastMessage: undefined,
    activeConversationUsesCollaboration: false,
    activeCollaborationConversationHostNodeId: null,
    activeCollaborationConversationHostUrl: null,
    activeCollaborationConversation: null,
    activeCollaborationAwaitingReply: false,
    isCollaborationSyncing: false,
    lastCollaborationSyncAtLabel: null,
    activeSessionProject: null,
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.match(markup, /No planning or execution task activity in this session yet/);
});

test('chat detail participant presence renders as compact status lights without visible status text', () => {
  const markup = renderInfoPanel({
    canonicalParticipants: [
      {
        id: 'human:111',
        name: '111',
        kind: 'human',
        role: 'person',
        avatarKey: '111',
        presenceStatus: 'online',
      },
      {
        id: 'human:222',
        name: 'Me',
        kind: 'human',
        role: 'self',
        avatarKey: '222',
        presenceStatus: 'online',
      },
    ],
  });

  assert.match(markup, /data-presence-status="online"/);
  assert.match(markup, /aria-label="Status: online"/);
  assert.doesNotMatch(markup, />online<\//);
  assert.doesNotMatch(markup, /app-badge-neutral[^>]*>online/);
});

test('chat detail panel hides outreach, trust, and mode metadata in Bridge chat info', () => {
  const markup = renderInfoPanel({
    outreach: baseOutreach,
    identity: {
      sourceHostId: 'bridge-host-1',
      localHumanId: 'human-local',
      localHumanName: 'Kordi User 1',
      localAgentId: 'agent-local',
      localAgentName: "Kordi User 1's Kordi",
      remoteHumanId: 'human-remote',
      remoteHumanName: 'Kordi User 3',
      remoteAgentName: null,
    },
  });

  assert.match(markup, /Weekend plan/);
  assert.doesNotMatch(markup, /Outreach status/);
  assert.doesNotMatch(markup, /<div class="app-detail-kicker">Outreach<\/div>/);
  assert.doesNotMatch(markup, /Person outreach/);
  assert.doesNotMatch(markup, /NLP\/AI conference deadlines/);
  assert.doesNotMatch(markup, /Source chat ID/);
  assert.doesNotMatch(markup, /Local human/);
  assert.doesNotMatch(markup, /Remote human/);
  assert.doesNotMatch(markup, /Trust/);
  assert.doesNotMatch(markup, /Owned/);
  assert.doesNotMatch(markup, /Mode/);
  assert.doesNotMatch(markup, /Group chat/);
});

test('chat detail panel never shows explicit outreach metadata in the normal info view', () => {
  const markup = renderInfoPanel({
    type: 'external-agent',
    directness: 'Agent outreach',
    outreach: {
      ...baseOutreach,
      targetKind: 'agent',
      targetAgentId: 'agent-remote',
      targetDisplayName: "Kordi User 3's Kordi",
      requestText: 'Summarize this thread',
      triggerText: "@Kordi User 3's Kordi Summarize this thread",
      contextPolicy: 'recent-window',
      status: 'awaitingReply',
    },
  });

  assert.match(markup, /Weekend plan/);
  assert.doesNotMatch(markup, /Outreach status/);
  assert.doesNotMatch(markup, /<div class="app-detail-kicker">Outreach<\/div>/);
  assert.doesNotMatch(markup, /Agent outreach/);
  assert.doesNotMatch(markup, /Summarize this thread/);
  assert.doesNotMatch(markup, /Kordi User 3&#x27;s Kordi/);
});

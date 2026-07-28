import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectDetailPanel } from '../src/pages/ProjectDetailPanel';

test('project detail task panel renders synced delegated Cloud task activity rows', () => {
  const activeProjectSession = {
    id: 'session:project:one',
    name: 'Project session',
    summary: 'Latest work',
    lastActive: '10:00',
    status: 'Active',
    participants: ['Me', 'Remote Kordi'],
    artifacts: 0,
    tasks: 1,
    messages: [],
    taskActivities: [{
      id: 'delegation:project:1',
      sessionId: 'session:project:one',
      status: 'complete',
      initiator: { id: 'human:me', name: 'Me', kind: 'human', role: 'self', avatarKey: 'me' },
      target: { id: 'agent:remote', name: 'Remote Kordi', kind: 'agent', role: 'external-agent', avatarKey: 'remote-agent' },
      participants: [
        { id: 'human:me', name: 'Me', kind: 'human', role: 'self', avatarKey: 'me' },
        { id: 'agent:remote', name: 'Remote Kordi', kind: 'agent', role: 'external-agent', avatarKey: 'remote-agent' },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
      sourceConversationId: 'bridge:host:remote-agent',
      sourceRequestId: 'bridge_req_project_task',
      contextPolicy: 'session-message',
    }],
  };

  const markup = renderToStaticMarkup(createElement(ProjectDetailPanel, {
    isNativeShell: true,
    activeDetailTab: 'tasks',
    activeProject: {
      id: 'project:root',
      name: 'Project',
      summary: 'Summary',
      bridge: 'Local',
      scope: '/tmp/project',
      status: 'Local',
      people: ['Me'],
      agents: ['Kordi'],
      pendingInvites: [],
      artifacts: 0,
      tasks: 1,
      root: '/tmp/project',
      sessions: [activeProjectSession],
    },
    activeProjectSession,
    activeProjectLastMessage: undefined,
    activeProjectCollaborationHost: null,
    activeProjectCollaborationProject: null,
    isProjectBridgeBusy: false,
    bridgeInvite: null,
    onCreateProjectBridgeInvite: () => {},
    onOpenBridgeHosts: () => {},
    onSetTasksTab: () => {},
    getStatusBadgeClass: () => 'app-badge-neutral',
    artifacts: [],
    activeArtifactId: null,
    onSelectArtifact: () => {},
  }));

  assert.doesNotMatch(markup, /No planning or execution task activity in this project session yet/);
  assert.match(markup, /app-inspector-source-row/);
  assert.match(markup, /Remote Kordi/);
  assert.match(markup, /Synced Cloud task by Me\./);
  assert.match(markup, /ID:\s*bridge_req_project_task/);
  assert.match(markup, /aria-label="Task target participants"/);
  assert.doesNotMatch(markup, /Delegated by Me/);
});

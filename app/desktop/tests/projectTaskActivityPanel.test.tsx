import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectDetailPanel } from '../src/pages/ProjectDetailPanel';

test('project detail task panel ignores simple delegated chat task activity rows', () => {
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
      bridgeConversationId: 'bridge:host:remote-agent',
      bridgeRequestId: 'bridge_req_project_task',
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
    activeProjectBridgeHost: null,
    activeProjectBridgeProject: null,
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

  assert.match(markup, /No planning or execution task activity in this project session yet/);
  assert.doesNotMatch(markup, /app-inspector-source-row/);
  assert.doesNotMatch(markup, /Remote Kordi/);
  assert.doesNotMatch(markup, /Delegated by Me/);
  assert.doesNotMatch(markup, /Shared with 2 participants/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { assembleRightDetailSlot } from '../src/app/assembleRightDetailSlot';
import type { RightDetailShellArgs } from '../src/app/kordiShellSlots.types';

function baseArgs(overrides: Partial<RightDetailShellArgs> = {}): RightDetailShellArgs {
  return {
    isNativeShell: true,
    activeNav: 'chats',
    activeDetailTab: 'info',
    setActiveDetailTab: () => {},
    activeSourcePreview: null,
    setActiveSourcePreview: () => {},
    activeArtifactId: null,
    setActiveArtifactId: () => {},
    activeChatArtifacts: [],
    activeProjectArtifacts: [],
    activeProject: {
      id: 'project:one', name: 'Project', summary: '', bridge: 'Local', scope: '/tmp', status: 'Local',
      people: [], agents: [], pendingInvites: [], artifacts: 0, tasks: 0, root: '/tmp', sessions: [],
    },
    activeProjectSession: {
      id: 'session:project:one', name: 'Project chat', summary: '', lastActive: '--:--', status: 'Active',
      participants: [], artifacts: 0, tasks: 0, messages: [],
    },
    activeProjectLastMessage: undefined,
    activeProjectBridgeHost: null,
    activeProjectBridgeProject: null,
    isProjectBridgeBusy: false,
    bridgeInvite: null,
    handleCreateProjectBridgeInvite: async () => {},
    setActiveNav: () => {},
    setActiveConvId: () => {},
    getStatusBadgeClass: () => 'app-badge-neutral',
    desktopLiveTurn: null,
    activeConv: {
      id: 'session:group:cloud-one',
      canonicalSessionId: 'session:group:cloud-one',
      name: 'Cloud group',
      type: 'person',
      subtitle: 'session:group:cloud-one',
      unread: 0,
      bridges: ['Cloud'],
      trust: 'Cloud',
      directness: 'Group chat',
      participants: ['Me'],
      messages: [],
      taskActivities: [],
    },
    activeConvHasSubtitle: true,
    activeLastMessage: undefined,
    activeConversationIsBridge: true,
    activeBridgeConversationHost: null,
    activeBridgeConversation: null,
    activeBridgeAwaitingReply: false,
    isBridgePolling: false,
    lastBridgePollAtLabel: null,
    activeSessionProject: null,
    activeQueuedDesktopMessages: [],
    chatTranscriptScrollRef: { current: null },
    ...overrides,
  };
}

test('Cloud Edition chat right rail includes the Tasks tab', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __KORDI_BOOTSTRAP__: { edition: 'cloud', title: 'Kordi Cloud' },
      location: { search: '?edition=cloud' },
      localStorage: null,
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { title: 'Kordi Cloud' },
  });

  const markup = renderToStaticMarkup(createElement(() => assembleRightDetailSlot(baseArgs())));

  assert.match(markup, /Info/);
  assert.match(markup, /Artifacts/);
  assert.match(markup, /Tasks/);
});

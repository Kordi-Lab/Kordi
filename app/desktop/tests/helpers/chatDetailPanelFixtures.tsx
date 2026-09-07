import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatDetailPanel } from "../../src/pages/ChatDetailPanel";

export const baseOutreach = {
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

export function renderInfoPanel(overrides = {}) {
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

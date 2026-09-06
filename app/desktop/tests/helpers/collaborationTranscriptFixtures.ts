import type { DesktopCollaborationConversation,DesktopCollaborationHost } from "../../src/kordi-app/types";

export function host(overrides: Partial<DesktopCollaborationHost> = {}): DesktopCollaborationHost {
  return {
    id: 'host-1',
    registered: true,
    connected: true,
    serverUrl: 'https://bridge.test',
    nodeId: 'node-me',
    displayName: 'My Kordi',
    ownerName: 'Me',
    endpoint: 'https://bridge.test',
    tokenPresent: true,
    humanId: 'human-me',
    discoveryMode: 'ask',
    activeAgentId: null,
    agents: [],
    visiblePeers: [],
    visiblePeerCount: 0,
    projects: [],
    ...overrides,
  };
}

export function conversation(overrides: Partial<DesktopCollaborationConversation> = {}): DesktopCollaborationConversation {
  return {
    id: 'bridge:host-1:node-peer:person',
    canonicalSessionId: 'session:bridge:humans:peer',
    hostId: 'host-1',
    peerNodeId: 'node-peer',
    peerDisplayName: 'Ethan',
    peerOwnerName: 'Ethan',
    peerRuntime: 'person',
    projectId: null,
    projectName: null,
    title: 'Ethan',
    subtitle: 'hi',
    unreadCount: 0,
    updatedAtMs: 1,
    updatedAtLabel: '16:39',
    awaitingReply: false,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: null,
    identity: null,
    messages: [],
    ...overrides,
  };
}

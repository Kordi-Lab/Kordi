import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bridgeContactRequestsForContactsPage, bridgePeerIsApprovedContact, bridgePeerIsReachableAgent, conversationSessionId, dedupeAdjacentAgentTurns, formatSessionIdSubtitle, hideRawConversationIds, localOwnedAgentSenderLabel, suppressLiveTurnEchoMessages } from '../src/app/viewModels/helpers';
import type { DesktopBridgeHost, DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';

function bridgeHost(overrides: Partial<DesktopBridgeHost> = {}): DesktopBridgeHost {
  return {
    id: 'host-1',
    registered: true,
    connected: true,
    serverUrl: 'http://127.0.0.1:17080',
    nodeId: 'kd_self',
    displayName: 'My Kordi',
    ownerName: 'Me',
    endpoint: 'http://127.0.0.1:17080/kd_self',
    tokenPresent: true,
    humanId: 'kh_self',
    discoveryMode: 'open',
    humanVisibilityPolicy: 'server-approval',
    contactApprovalPolicy: 'approval-required',
    activeAgentId: null,
    agents: [],
    visiblePeers: [],
    visiblePeerCount: 0,
    projects: [],
    contactRequests: [],
    lastError: null,
    ...overrides,
  };
}

test('bridgePeerIsApprovedContact treats only approved bridge peers as Contacts-page contacts', () => {
  const basePeer = {
    nodeId: 'kd_bob',
    displayName: 'Bob Agent',
    runtime: 'person',
    endpoint: '',
    ownerName: 'Bob',
    createdAt: null,
    sharedProjects: [],
    humanId: 'kh_bob',
    agentId: null,
    isDefaultAgent: false,
    discoveryMode: null,
    humanVisibilityPolicy: 'server-approval',
    contactApprovalPolicy: 'approval-required',
    agentReachabilityPolicy: 'contacts',
    isContact: false,
    contactRequestStatus: null,
    contactRequestDirection: null,
  };

  assert.equal(bridgePeerIsApprovedContact(basePeer), false);
  assert.equal(bridgePeerIsApprovedContact({ ...basePeer, contactRequestStatus: 'pending' }), false);
  assert.equal(bridgePeerIsApprovedContact({ ...basePeer, isContact: true }), true);
  assert.equal(bridgePeerIsApprovedContact({ ...basePeer, contactRequestStatus: 'approved' }), true);
});

test('bridgePeerIsReachableAgent hides owner-only agents from other people', () => {
  const basePeer = {
    nodeId: 'kd_agent',
    displayName: 'Owner Kordi',
    runtime: 'kordi-desktop',
    endpoint: '',
    ownerName: 'Owner',
    createdAt: null,
    sharedProjects: [],
    humanId: 'kh_owner',
    agentId: 'ka_owner',
    isDefaultAgent: true,
    discoveryMode: null,
    humanVisibilityPolicy: 'server-approval',
    contactApprovalPolicy: 'approval-required',
    isContact: true,
    contactRequestStatus: 'contact',
    contactRequestDirection: null,
  };

  assert.equal(bridgePeerIsReachableAgent({ ...basePeer, agentReachabilityPolicy: 'owner' }), false);
  assert.equal(bridgePeerIsReachableAgent({ ...basePeer, agentReachabilityPolicy: 'contacts' }), true);
  assert.equal(bridgePeerIsReachableAgent({ ...basePeer, agentReachabilityPolicy: 'server' }), true);
  assert.equal(bridgePeerIsReachableAgent({ ...basePeer, runtime: 'person', agentReachabilityPolicy: 'owner' }), false);
});

test('bridgeContactRequestsForContactsPage exposes pending incoming approvals only', () => {
  const requests = bridgeContactRequestsForContactsPage(bridgeHost({
    visiblePeers: [{
      nodeId: 'kd_bob',
      displayName: 'Bob Agent',
      runtime: 'person',
      endpoint: '',
      ownerName: 'Bob',
      createdAt: null,
      sharedProjects: [],
      humanId: 'kh_bob',
      agentId: null,
      isDefaultAgent: false,
      discoveryMode: null,
      humanVisibilityPolicy: 'server-approval',
      contactApprovalPolicy: 'approval-required',
      agentReachabilityPolicy: 'contacts',
      isContact: false,
      contactRequestStatus: 'pending',
      contactRequestDirection: 'incoming',
    }],
    contactRequests: [
      { requestId: 'req-in', requesterNodeId: 'kd_bob', targetNodeId: 'kd_self', status: 'pending', message: 'Please add me', createdAt: '2026-05-05T00:00:00Z', direction: 'incoming' },
      { requestId: 'req-out', requesterNodeId: 'kd_self', targetNodeId: 'kd_alice', status: 'pending', message: null, createdAt: '2026-05-05T00:00:00Z', direction: 'outgoing' },
      { requestId: 'req-done', requesterNodeId: 'kd_carol', targetNodeId: 'kd_self', status: 'approved', message: null, createdAt: '2026-05-05T00:00:00Z', direction: 'incoming' },
    ],
  }));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].title, 'Bob wants to connect');
  assert.equal(requests[0].detail, 'Please add me');
  assert.equal(requests[0].bridgeHostId, 'host-1');
  assert.equal(requests[0].bridgeRequestId, 'req-in');
});

test('hideRawConversationIds keeps friendly names and preserves canonical ids as subtitles', () => {
  const [conversation] = hideRawConversationIds([{
    id: 'bridge:host:peer:person',
    canonicalSessionId: 'session:bridge:humans:01cdf04168888ea08ffd7069',
    name: 'Bob',
    type: 'person',
    subtitle: 'Direct human chat',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Bob'],
    messages: [{
      role: 'user',
      text: 'Please keep this message out of the row title.',
      time: '23:34',
    }],
  }]);

  assert.equal(
    conversation.name,
    'Bob',
    'canonical bridge human ids must not replace user-facing conversation names',
  );
  assert.equal(
    conversation.subtitle,
    'session:bridge:humans:01cdf04168888ea08ffd7069',
    'canonical session id should remain available for subtitle/debug display',
  );
});

test('hideRawConversationIds replaces raw names with stable friendly fallbacks', () => {
  const [rawNamedConversation, draftConversation] = hideRawConversationIds([{
    id: 'session:bridge:humans:01cdf04168888ea08ffd7069',
    canonicalSessionId: 'session:bridge:humans:01cdf04168888ea08ffd7069',
    name: 'session:bridge:humans:01cdf04168888ea08ffd7069',
    type: 'person',
    subtitle: 'Direct human chat',
    unread: 0,
    bridges: ['Bridge'],
    trust: 'Bridge',
    directness: 'Direct person chat',
    participants: ['Me', 'Alice'],
    messages: [{
      role: 'user',
      text: 'Hi shu. Please check this issue after that.',
      time: '23:34',
    }],
  }, {
    id: 'draft:local-chat',
    canonicalSessionId: undefined,
    name: 'draft:local-chat',
    type: 'owned-agent',
    subtitle: 'Draft',
    unread: 0,
    bridges: ['Local'],
    trust: 'Owned',
    directness: 'Direct chat',
    participants: ['Me', 'Kordi'],
    messages: [{
      role: 'system',
      text: 'Session ready',
      time: '23:34',
    }, {
      role: 'user',
      text: 'This is a very long first sentence that should be clipped before it overwhelms the chat header and session rail. More detail follows.',
      time: '23:35',
    }],
  }]);

  assert.equal(
    rawNamedConversation.name,
    'Hi shu.',
    'raw canonical bridge ids should use the first sentence of the first user message',
  );
  assert.equal(
    conversationSessionId(rawNamedConversation),
    'session:bridge:humans:01cdf04168888ea08ffd7069',
    'canonical session id should remain available to callers',
  );
  assert.equal(
    draftConversation.name,
    'This is a very long first sentence that should be clipped before it overwhelms the chat header and session rail.',
    'derived titles should keep the full first sentence so CSS can adapt truncation to available width',
  );
});

test('resolves the live local agent sender from canonical participant scope', () => {
  assert.equal(localOwnedAgentSenderLabel({
    canonicalParticipants: [{
      id: 'agent:local:1',
      name: 'My Kordi',
      kind: 'agent',
      role: 'delegate',
      source: 'local',
      ownerIdentityId: 'human:profile:1',
      ownerName: 'You',
    }],
    participants: ['Me', 'Kordi'],
    messages: [],
  }), 'My Kordi');
});

test('defaults the live local agent sender to My Kordi instead of bare Kordi', () => {
  assert.equal(localOwnedAgentSenderLabel({
    participants: ['Me', 'Kordi'],
    messages: [],
  }), 'My Kordi');
});

test('formatSessionIdSubtitle labels raw ids for display', () => {
  assert.equal(
    formatSessionIdSubtitle('63138d66-0f5b-40dd-90ea-605f7cdb9ba0'),
    'Session ID: 63138d66-0f5b-40dd-90ea-605f7cdb9ba0',
  );
  assert.equal(formatSessionIdSubtitle('  '), '');
  assert.equal(formatSessionIdSubtitle('Direct human chat'), 'Direct human chat');
  assert.equal(
    formatSessionIdSubtitle('session:bridge:bridge:bridge_18e6ee0dbc0d4785a3454a64129fe23b:kd_4FiDc8WETK5o26Ece6XvHFm6b8g9'),
    'Session ID: session:bridge:bridge:bridge_18e6ee0dbc0d4785a3454a64129fe23b:kd_4FiDc8WETK5o26Ece6XvHFm6b8g9',
  );
  assert.equal(
    formatSessionIdSubtitle('session:bridge:humans:c49e4abc'),
    'Session ID: session:bridge:humans:c49e4abc',
  );
  assert.equal(
    formatSessionIdSubtitle('session:group:437f306a-6278-4b64-a635-79a71d2cb3e0'),
    'Session ID: session:group:437f306a-6278-4b64-a635-79a71d2cb3e0',
  );
  assert.equal(formatSessionIdSubtitle('session:direct-agent:next-id'), 'Session ID: session:direct-agent:next-id');
});

function turn(overrides: Partial<DesktopChatTurnSnapshot> = {}): DesktopChatTurnSnapshot {
  return {
    id: 'turn-1',
    sessionId: 'session-1',
    prompt: 'check issue',
    status: 'complete',
    message: 'Complete',
    assistantText: 'Using the requested-skills workflow first, then I will inspect the repo context.',
    thinkingText: 'Reasoning trace',
    tools: [{
      id: 'tool-1',
      name: 'grep',
      status: 'done',
      arguments: '{"pattern":"issue"}',
      liveOutput: '',
      resultText: 'matched issue context',
      detail: '23ms',
      isError: false,
    }],
    completed: true,
    succeeded: true,
    error: null,
    ...overrides,
  };
}

function agentMessage(sender: string, messageTurn: DesktopChatTurnSnapshot, overrides: Partial<Message> = {}): Message {
  return {
    role: 'owned-agent',
    sender,
    senderType: 'agent',
    text: '',
    time: '12:36',
    turn: messageTurn,
    ...overrides,
  };
}

test('dedupes adjacent duplicate local agent turns even when sender aliases differ', () => {
  const first = agentMessage('My Kordi', turn());
  const second = agentMessage('Kordi', turn({ id: 'turn-2' }));

  const deduped = dedupeAdjacentAgentTurns([first, second]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0], second);
});

test('drops local tool-only alias turn when next local alias turn contains the final answer', () => {
  const toolOnly = agentMessage('My Kordi', turn({ id: 'turn-tool-only', assistantText: '' }));
  const finalAnswer = agentMessage('Kordi', turn({ id: 'turn-final' }));

  const deduped = dedupeAdjacentAgentTurns([toolOnly, finalAnswer]);

  assert.deepEqual(deduped, [finalAnswer]);
});

test('drops local intro fragment when the following final local turn extends it', () => {
  const intro = agentMessage('Kordi', turn({
    id: 'turn-intro',
    assistantText: 'I’ll check current web sources for today’s weather in Thuwal.',
    thinkingText: '**Checking weather in Thuwal**',
    tools: [],
  }));
  const finalAnswer = agentMessage('My Kordi', turn({
    id: 'turn-final-weather',
    assistantText: 'I’ll check current web sources for today’s weather in Thuwal.\n\nToday’s weather in **Thuwal, Saudi Arabia**:',
    thinkingText: '**Checking weather in Thuwal**',
  }));

  const deduped = dedupeAdjacentAgentTurns([intro, finalAnswer]);

  assert.deepEqual(deduped, [finalAnswer]);
});

test('drops local intro fragment across minute boundary when historical prompts are unavailable', () => {
  const intro = agentMessage('Kordi', turn({
    id: 'turn-brainstorm-intro',
    prompt: '',
    assistantText: "I'm using the brainstorming skill to explore website options before any build plan.",
    thinkingText: '',
    tools: [],
  }), { time: '10:59' });
  const finalAnswer = agentMessage('My Kordi', turn({
    id: 'turn-brainstorm-final',
    prompt: '',
    assistantText: "I'm using the brainstorming skill to explore website options before any build plan. Some of what we're working on might be easier to explain visually.",
    thinkingText: '',
  }), { time: '11:00' });

  const deduped = dedupeAdjacentAgentTurns([intro, finalAnswer]);

  assert.deepEqual(deduped, [finalAnswer]);
});

test('drops local tool-bearing intro fragment when a refreshed final turn extends it', () => {
  const intro = agentMessage('Kordi', turn({
    id: 'turn-repo-intro',
    prompt: '',
    assistantText: 'Using the brainstorming, TDD, debugging/review, and worktree skills to clarify the issue, inspect the implementation, review it, and implement safely.',
    thinkingText: 'Inspecting the repo',
    tools: [{
      id: 'tool-status',
      name: 'bash',
      status: 'done',
      arguments: '{"command":"git status --short"}',
      liveOutput: '',
      resultText: 'ok',
      detail: null,
      artifactPath: null,
      toolLayer: 'execution',
      isError: false,
    }],
  }), { time: '20:05' });
  const finalAnswer = agentMessage('My Kordi', turn({
    id: 'turn-repo-final',
    prompt: '',
    assistantText: 'Using the brainstorming, TDD, debugging/review, and worktree skills to clarify the issue, inspect the implementation, review it, and implement safely. I found Kordi issue #301.',
    thinkingText: 'Inspecting the repo',
    tools: [{
      id: 'tool-status',
      name: 'bash',
      status: 'done',
      arguments: '{"command":"git status --short"}',
      liveOutput: '',
      resultText: 'ok',
      detail: null,
      artifactPath: null,
      toolLayer: 'execution',
      isError: false,
    }],
  }), { time: '20:06' });

  const deduped = dedupeAdjacentAgentTurns([intro, finalAnswer]);

  assert.deepEqual(deduped, [finalAnswer]);
});

test('keeps separate agent turns across minute boundary when prompts differ', () => {
  const first = agentMessage('Kordi', turn({
    id: 'turn-first',
    prompt: '@Kordi brainstorm website choices',
    assistantText: 'I can outline three website directions.',
    thinkingText: '',
    tools: [],
  }), { time: '10:59' });
  const second = agentMessage('My Kordi', turn({
    id: 'turn-second',
    prompt: '@Kordi now turn the first direction into a plan',
    assistantText: 'I can outline three website directions. Next, I will turn the first direction into a plan.',
    thinkingText: '',
  }), { time: '11:00' });

  const deduped = dedupeAdjacentAgentTurns([first, second]);

  assert.deepEqual(deduped, [first, second]);
});

test('suppresses all local owned-agent runtime fragments after the triggering user while live turn is rendered', () => {
  const olderAssistant = agentMessage('My Kordi', turn({ id: 'older-turn', assistantText: 'Older completed answer' }));
  const user: Message = {
    role: 'user',
    text: 'check todays thuwal weather',
    time: '16:04',
  };
  const thinkingFragment = agentMessage('Kordi', turn({
    id: 'raw-fragment-1',
    completed: true,
    assistantText: 'I’ll check current web sources for today’s weather in Thuwal.',
    thinkingText: '**Checking weather in Thuwal**',
  }));
  const toolFragment = agentMessage('Kordi', turn({
    id: 'raw-fragment-2',
    completed: true,
    assistantText: 'I’ll check current web sources for today’s weather in Thuwal.Today’s weather in **Thuwal, Saudi Arabia**:',
    tools: [{
      id: 'tool-web-fetch',
      name: 'web_fetch',
      status: 'done',
      arguments: '{}',
      liveOutput: '',
      resultText: 'weather result',
      detail: null,
      isError: false,
    }],
  }));
  const liveTurn = turn({
    id: 'live-turn-weather',
    status: 'running',
    message: 'Running',
    completed: false,
    assistantText: 'I’ll check current web sources for today’s weather in Thuwal.',
    thinkingText: '**Checking weather in Thuwal**',
  });

  assert.deepEqual(
    suppressLiveTurnEchoMessages([olderAssistant, user, thinkingFragment, toolFragment], liveTurn),
    [olderAssistant, user],
  );
});

test('suppresses canonical owned-agent echo while an equivalent live turn is rendered', () => {
  const user: Message = {
    role: 'user',
    text: 'check my diskusage again',
    time: '15:37',
  };
  const canonicalEcho = agentMessage('My Kordi', turn({
    id: 'canonical-turn-1',
    status: 'complete',
    message: 'Complete',
    completed: true,
    assistantText: 'I’ll check overall filesystem usage and the largest items in your home directory.',
    thinkingText: '**Checking disk usage**',
  }));
  const liveTurn = turn({
    id: 'live-turn-1',
    status: 'running',
    message: 'Running',
    completed: false,
    assistantText: 'I’ll check overall filesystem usage and the largest items in your home directory.',
    thinkingText: '**Checking disk usage**',
  });

  assert.deepEqual(suppressLiveTurnEchoMessages([user, canonicalEcho], liveTurn), [user]);
});

test('suppresses in-flight external-agent placeholder while an equivalent live turn is rendered', () => {
  const user: Message = {
    role: 'user',
    text: '@KordiUser4sKordi show me the potential restaurant',
    time: '22:43',
  };
  const externalAgentPlaceholder: Message = {
    role: 'external-agent',
    sender: "Kordi User 4's Kordi",
    senderType: 'agent',
    text: '',
    time: '22:43',
    turn: turn({
      id: 'canonical-bridge-relay-processing-1',
      status: 'processing',
      message: 'Processing…',
      completed: false,
      assistantText: '',
      thinkingText: '',
    }),
  };
  const liveTurn = turn({
    id: 'live-turn-1',
    status: 'running',
    message: 'Running',
    completed: false,
    assistantText: '',
    thinkingText: '**Checking the restaurant directory**',
  });

  assert.deepEqual(
    suppressLiveTurnEchoMessages([user, externalAgentPlaceholder], liveTurn),
    [user],
  );
});

test('keeps a completed external-agent reply visible alongside an active live turn', () => {
  const user: Message = {
    role: 'user',
    text: 'follow up question',
    time: '22:50',
  };
  // A completed prior reply from a remote agent should not be dropped — only in-flight
  // placeholders are duplicates of the live overlay.
  const completedRemoteReply: Message = {
    role: 'external-agent',
    sender: "Kordi User 4's Kordi",
    senderType: 'agent',
    text: 'Earlier answer.',
    time: '22:50',
    turn: turn({
      id: 'canonical-bridge-relay-completed-1',
      status: 'complete',
      message: 'Complete',
      completed: true,
      assistantText: 'Earlier answer.',
      thinkingText: '',
    }),
  };
  const liveTurn = turn({
    id: 'live-turn-2',
    status: 'running',
    message: 'Running',
    completed: false,
    assistantText: '',
    thinkingText: '',
  });

  assert.deepEqual(
    suppressLiveTurnEchoMessages([user, completedRemoteReply], liveTurn),
    [user, completedRemoteReply],
  );
});

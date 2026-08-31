import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendOptimisticCollaborationMessage } from '../src/features/chat/messageActions/optimistic';
import { COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS } from '../src/features/collaboration/collaborationProcessingState';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import { KORDI_SUPPORT_ACCOUNT_ID, KORDI_SUPPORT_AGENT_ID, KORDI_SUPPORT_NAME } from '../src/features/support/supportIdentity';
import type { DesktopCollaborationConversation, DesktopCollaborationState } from '../src/kordi-app/types';

function conversation(
  overrides: Partial<DesktopCollaborationConversation> = {},
): DesktopCollaborationConversation {
  return {
    id: 'bridge:cloud:node-peer',
    canonicalSessionId: 'session:bridge:agents:peer',
    hostId: 'cloud',
    peerNodeId: 'node-peer',
    peerDisplayName: "Ethan's Kordi",
    peerOwnerName: 'Ethan',
    peerRuntime: 'kordi-desktop',
    projectId: null,
    projectName: null,
    title: "Ethan's Kordi",
    subtitle: 'hi',
    unreadCount: 0,
    updatedAtMs: 1,
    updatedAtLabel: '21:03',
    awaitingReply: true,
    peerTyping: false,
    peerLastHeartbeatLabel: null,
    outreach: null,
    identity: null,
    messages: [],
    ...overrides,
  };
}

function processingConversation(timestampMs: number, requestId: string) {
  return conversation({
    messages: [{
      id: 'msg-request',
      direction: 'outbound',
      sender: 'Me',
      text: '@MyKordi hi',
      timeLabel: '21:03',
      timestampMs,
      requestId,
      deliveryState: 'sent',
      outreach: null,
    }, {
      id: 'msg-processing',
      direction: 'outbound-response',
      sender: 'My Kordi',
      text: 'processing...',
      timeLabel: '21:03',
      timestampMs: timestampMs + 1,
      requestId,
      deliveryState: 'processing',
      outreach: null,
    }],
  });
}

test('bridge transcript expires an orphaned historical processing response with its request', () => {
  const nowMs = Date.parse('2026-08-02T12:00:00Z');
  const oldTimestampMs = nowMs - COLLABORATION_PROCESSING_PLACEHOLDER_MAX_AGE_MS - 1;
  const view = mapCollaborationConversationToViewModel(
    processingConversation(oldTimestampMs, 'bridge_req_orphaned_processing'),
    undefined,
    'My Kordi',
    nowMs,
  );

  assert.deepEqual(view.messages.map((message) => message.text), ['@MyKordi hi']);
  assert.equal(view.messages.some((message) => message.turn?.status === 'processing'), false);
});

test('bridge transcript keeps a fresh processing response visible', () => {
  const nowMs = Date.parse('2026-08-02T12:00:00Z');
  const view = mapCollaborationConversationToViewModel(
    processingConversation(nowMs - 1_000, 'bridge_req_active_processing'),
    undefined,
    'My Kordi',
    nowMs,
  );

  assert.equal(view.messages.some((message) => message.turn?.status === 'processing'), true);
});

test('direct person agent mentions show the renamed local agent processing immediately', () => {
  const conversationId = 'bridge:cloud:acct-peer:person';
  const state = appendOptimisticCollaborationMessage({
    activeHostId: 'cloud',
    hosts: [],
    conversations: [conversation({
      id: conversationId,
      canonicalSessionId: 'session:direct-person:acct-me:acct-peer',
      hostId: 'cloud',
      peerNodeId: 'acct-peer',
      peerDisplayName: 'Peer',
      peerOwnerName: 'Peer',
      peerRuntime: 'person',
      identity: {
        sourceHostId: 'cloud',
        localHumanId: 'acct-me',
        localHumanName: 'Me',
        localAgentId: 'agent-local',
        localAgentName: 'Kordirename11',
        localAgentNodeId: 'acct-me',
      },
    })],
  }, conversationId, '@Kordirename11 what are you doing', '21:04', 'request-local-agent', [], undefined, null, [{
    label: 'Kordirename11',
    targetKind: 'agent',
    targetIdentityId: 'agent:agent-local',
    sourceHostId: 'cloud',
    nodeId: 'acct-me',
    agentId: 'agent-local',
    displayLabel: 'Kordirename11',
  }]);
  const optimisticConversation = state?.conversations[0];
  assert.ok(optimisticConversation);
  assert.equal(optimisticConversation.awaitingReply, true);

  const view = mapCollaborationConversationToViewModel(optimisticConversation, undefined, 'Kordi');
  const processing = view.messages.find((message) => message.turn?.status === 'processing');
  assert.equal(processing?.role, 'owned-agent');
  assert.equal(processing?.sender, 'Kordirename11');
  assert.equal(processing?.turn?.completed, false);
});

test('Kordi Support shows contact typing without exposing the agent processing card', () => {
  const supportConversationId = `bridge:cloud:${KORDI_SUPPORT_ACCOUNT_ID}:person`;
  const state: DesktopCollaborationState = {
    activeHostId: 'cloud',
    hosts: [],
    conversations: [conversation({
      id: supportConversationId,
      canonicalSessionId: `session:bridge:agents:${KORDI_SUPPORT_AGENT_ID}`,
      peerNodeId: KORDI_SUPPORT_ACCOUNT_ID,
      peerDisplayName: KORDI_SUPPORT_NAME,
      peerOwnerName: KORDI_SUPPORT_NAME,
      peerRuntime: 'kordi-desktop',
      title: KORDI_SUPPORT_NAME,
      subtitle: 'Ask questions or suggest improvements',
      supportTicketEnabled: true,
      awaitingReply: false,
      messages: [],
    })],
  };

  const next = appendOptimisticCollaborationMessage(
    state,
    supportConversationId,
    'Which model are you using?',
    '07:42',
    'support-request-1',
  );
  const optimisticConversation = next?.conversations[0];
  assert.ok(optimisticConversation);
  assert.equal(optimisticConversation.awaitingReply, true);
  assert.equal(optimisticConversation.messages[0]?.requestId, 'support-request-1');

  const view = mapCollaborationConversationToViewModel(
    optimisticConversation,
    undefined,
    'My Kordi',
  );

  assert.equal(view.type, 'person');
  assert.equal(view.messages.length, 2);
  assert.equal(view.messages[0]?.role, 'user');
  assert.equal(view.messages[1]?.role, 'person');
  assert.equal(view.messages[1]?.sender, KORDI_SUPPORT_NAME);
  assert.equal(view.messages[1]?.text, '');
  assert.equal(view.messages[1]?.supportContactResponse, true);
  assert.equal(view.messages[1]?.supportContactTyping, true);
  assert.equal(view.messages[1]?.turn, undefined);
  assert.equal(view.messages.some((message) => message.turn?.status === 'processing'), false);
});

test('Kordi Support identity suppresses stale user-provider failures before canonical hydration', () => {
  const requestId = 'support-request-stale-auth';
  const view = mapCollaborationConversationToViewModel(
    conversation({
      id: `cloud:conversation:acct_real_support_owner:agent:session:session%3Adirect-system-agent%3Aacct_me%3A${KORDI_SUPPORT_AGENT_ID}`,
      canonicalSessionId: `session:direct-system-agent:acct_me:${KORDI_SUPPORT_AGENT_ID}`,
      peerNodeId: 'acct_real_support_owner',
      peerDisplayName: KORDI_SUPPORT_NAME,
      peerOwnerName: 'Kordi',
      peerRuntime: 'kordi-desktop',
      title: KORDI_SUPPORT_NAME,
      subtitle: 'Ask questions or suggest improvements',
      supportTicketEnabled: false,
      awaitingReply: false,
      identity: {
        sourceHostId: 'cloud',
        localHumanId: 'acct_me',
        localHumanName: 'Me',
        localAgentId: 'cloud-local-agent',
        localAgentName: 'My Kordi',
        localAgentNodeId: 'acct_me',
        remoteHumanId: 'acct_real_support_owner',
        remoteHumanName: 'Kordi',
        remoteHumanNodeId: 'acct_real_support_owner',
        remoteAgentId: KORDI_SUPPORT_AGENT_ID,
        remoteAgentName: KORDI_SUPPORT_NAME,
        remoteAgentNodeId: 'acct_real_support_owner',
        remoteAgentRuntime: 'kordi-desktop',
      },
      messages: [{
        id: 'support-request-message',
        direction: 'outbound',
        sender: 'Me',
        text: 'hi',
        timeLabel: '13:30',
        timestampMs: 1,
        requestId,
        deliveryState: 'sent',
        outreach: null,
      }, {
        id: 'support-stale-auth-failure',
        direction: 'inbound-response',
        sender: KORDI_SUPPORT_NAME,
        text: 'No provider configured yet.',
        timeLabel: '13:30',
        timestampMs: 2,
        requestId,
        deliveryState: 'failed',
        outreach: null,
      }],
    }),
    undefined,
    'My Kordi',
  );

  assert.equal(view.name, KORDI_SUPPORT_NAME);
  assert.equal(view.supportTicketEnabled, true);
  assert.deepEqual(view.messages.map((message) => message.text), ['hi']);
});

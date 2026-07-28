import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

const VIEWER_PROFILE_ID = 'human:profile:viewer';
const SENDER_LOCAL_ID = 'human:profile:sender';
const SENDER_BRIDGE_ID = 'human:kh_sender_bridge';
const AGENT_OWNER_ID = SENDER_LOCAL_ID;
const REMOTE_AGENT_OWNER_ID = SENDER_BRIDGE_ID;

function identitiesById(): Map<string, CanonicalIdentity> {
  return new Map<string, CanonicalIdentity>([
    [VIEWER_PROFILE_ID, {
      id: VIEWER_PROFILE_ID,
      kind: 'human',
      displayName: 'You',
      source: 'local',
      avatarKey: 'viewer',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    [SENDER_LOCAL_ID, {
      id: SENDER_LOCAL_ID,
      kind: 'human',
      displayName: 'Sender',
      source: 'local',
      avatarKey: 'sender',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    [SENDER_BRIDGE_ID, {
      id: SENDER_BRIDGE_ID,
      kind: 'human',
      displayName: 'Sender (Bridge)',
      source: 'bridge',
      avatarKey: 'sender_bridge',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    [AGENT_OWNER_ID, {
      id: AGENT_OWNER_ID,
      kind: 'human',
      displayName: 'Sender',
      source: 'local',
      avatarKey: 'sender',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    ['agent:local:owner', {
      id: 'agent:local:owner',
      kind: 'agent',
      displayName: 'Kordi',
      ownerIdentityId: AGENT_OWNER_ID,
      source: 'local',
      avatarKey: 'agent_local',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
    ['agent:remote', {
      id: 'agent:remote',
      kind: 'agent',
      displayName: "Sender's Kordi",
      ownerIdentityId: REMOTE_AGENT_OWNER_ID,
      source: 'bridge',
      avatarKey: 'agent_remote',
      createdAtMs: 1,
      updatedAtMs: 1,
    }],
  ]);
}

function processingAgentTurnMessage(senderIdentityId: string, parentMessageId: string): CanonicalSessionMessage {
  return {
    id: 'msg:agent-turn:1',
    sessionId: 'session:group:test',
    senderIdentityId,
    senderRole: senderIdentityId === 'agent:local:owner' ? 'owned-agent' : 'external-agent',
    messageKind: 'agent-turn',
    contentText: 'processing...',
    content: {
      deliveryState: 'processing',
      sourceConversationId: 'bridge:conv-1',
      requestId: 'bridge_req_1',
    },
    parentMessageId,
    status: 'processing',
    sequenceNum: 2,
    createdAtMs: 100,
    updatedAtMs: 100,
    sourceTransport: 'desktop-bridge-session-relay',
  };
}

function userMessageRow(senderIdentityId: string, id: string): CanonicalSessionMessage {
  return {
    id,
    sessionId: 'session:group:test',
    senderIdentityId,
    senderRole: 'user',
    messageKind: 'text',
    contentText: '@KordiSenderKordi check the steak price',
    parentMessageId: null,
    status: 'sent',
    sequenceNum: 1,
    createdAtMs: 99,
    updatedAtMs: 99,
    sourceTransport: 'desktop-bridge-session-relay',
  };
}

test('agent owner viewing their own running turn keeps the stop button', () => {
  const userMsg = userMessageRow(SENDER_LOCAL_ID, 'msg:user:1');
  const turn = processingAgentTurnMessage('agent:local:owner', 'msg:user:1');
  const senderIdentityIdByMessageId = new Map([[userMsg.id, userMsg.senderIdentityId]]);
  const mapped = mapCanonicalMessage(turn, identitiesById(), VIEWER_PROFILE_ID, { senderIdentityIdByMessageId });
  // Even though the parent message sender isn't the viewer, the viewer owns the agent locally.
  // Re-map with VIEWER_PROFILE_ID === AGENT_OWNER_ID to assert owner authorization.
  const ownerMapped = mapCanonicalMessage(turn, identitiesById(), AGENT_OWNER_ID, { senderIdentityIdByMessageId });
  assert.ok(ownerMapped?.turn?.pendingCollaborationAgentRequest, 'agent owner should see stop control');
  assert.equal(mapped?.turn?.pendingCollaborationAgentRequest, undefined, 'non-owner non-sender should not see stop control');
});

test('mention sender viewing the running turn keeps the stop button', () => {
  const userMsg = userMessageRow(VIEWER_PROFILE_ID, 'msg:user:1');
  const turn = processingAgentTurnMessage('agent:remote', 'msg:user:1');
  const senderIdentityIdByMessageId = new Map([[userMsg.id, userMsg.senderIdentityId]]);
  const mapped = mapCanonicalMessage(turn, identitiesById(), VIEWER_PROFILE_ID, { senderIdentityIdByMessageId });
  assert.ok(mapped?.turn?.pendingCollaborationAgentRequest, 'mention sender should see stop control');
});

test('bystander viewing a remote agent running turn does not see the stop button', () => {
  const userMsg = userMessageRow(SENDER_BRIDGE_ID, 'msg:user:1');
  const turn = processingAgentTurnMessage('agent:remote', 'msg:user:1');
  const senderIdentityIdByMessageId = new Map([[userMsg.id, userMsg.senderIdentityId]]);
  const mapped = mapCanonicalMessage(turn, identitiesById(), VIEWER_PROFILE_ID, { senderIdentityIdByMessageId });
  assert.equal(mapped?.turn?.pendingCollaborationAgentRequest, undefined, 'bystander should not see stop control');
});

test('missing sender lookup falls back to hiding the control rather than leaking it', () => {
  const turn = processingAgentTurnMessage('agent:remote', 'msg:user:1');
  const mapped = mapCanonicalMessage(turn, identitiesById(), VIEWER_PROFILE_ID);
  assert.equal(mapped?.turn?.pendingCollaborationAgentRequest, undefined, 'no context should default to hidden');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import {
  buildParticipantSpaces,
  filterParticipantSpaces,
} from '../src/features/chat/participantSpaces';
import {
  KORDI_SUPPORT_AGENT_ID,
  KORDI_SUPPORT_AVATAR_URL,
  KORDI_SUPPORT_NAME,
} from '../src/features/support/supportIdentity';

const sessionId = 'session:direct-agent:acct_me:cloud_agent_kordi_support';

test('canonical hydration preserves the fixed Kordi Support contact identity', () => {
  const readModel = createCanonicalSessionReadModel({
    storagePath: '/tmp/canonical.sqlite3',
    profile: {
      id: 'profile:me',
      displayName: 'Me',
      humanIdentityId: 'human:me',
      activeAgentIdentityId: 'agent:local',
      storageRoot: '/tmp',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    identities: [
      { id: 'human:me', kind: 'human', displayName: 'Me', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:local', kind: 'agent', displayName: 'My Kordi', source: 'local', ownerIdentityId: 'human:me', avatarKey: 'local-agent', createdAtMs: 1, updatedAtMs: 1 },
      { id: 'agent:support', kind: 'agent', displayName: KORDI_SUPPORT_NAME, source: 'cloud', sourceHostId: 'cloud', sourceIdentityId: KORDI_SUPPORT_AGENT_ID, agentId: KORDI_SUPPORT_AGENT_ID, avatarKey: KORDI_SUPPORT_AGENT_ID, createdAtMs: 1, updatedAtMs: 1 },
    ],
    sessions: [{
      id: sessionId,
      kind: 'direct-agent',
      title: 'Support routing verification: reply with Kordi Support is ready',
      status: 'active',
      createdByIdentityId: 'human:me',
      primaryIdentityId: 'agent:support',
      relationshipIdentityId: 'agent:support',
      metadata: { source: 'cloud-direct', sourceHostId: 'cloud', peerNodeId: KORDI_SUPPORT_AGENT_ID, peerRuntime: 'kordi-desktop' },
      createdAtMs: 1,
      updatedAtMs: 7,
      lastMessageAtMs: 7,
    }],
    participants: [
      { sessionId, identityId: 'human:me', role: 'self', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
      { sessionId, identityId: 'agent:support', role: 'delegate', state: 'active', addedByIdentityId: 'human:me', addedAtMs: 1 },
    ],
    messages: [
      { id: 'message:request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Support routing verification', content: { sender: 'Me', timeLabel: '14:44' }, status: 'sent', sequenceNum: 1, createdAtMs: 2, updatedAtMs: 2, contentHash: null, sourceTransport: 'cloud-direct', sourceEventId: 'request' },
      { id: 'message:response', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Kordi Support is ready.', content: { sender: 'My Kordi', timeLabel: '14:44' }, status: 'complete', sequenceNum: 2, createdAtMs: 3, updatedAtMs: 3, contentHash: null, sourceTransport: 'cloud-direct', sourceEventId: 'response' },
      { id: 'message:greeting', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'hi', content: { sender: 'Me', timeLabel: '15:11' }, status: 'sent', sequenceNum: 3, createdAtMs: 4, updatedAtMs: 4, contentHash: null, sourceTransport: 'cloud-direct', sourceEventId: 'greeting' },
      { id: 'message:greeting-response', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Hi! Kordi Support is ready. How can I help?', content: { sender: 'My Kordi', timeLabel: '15:11' }, status: 'complete', sequenceNum: 4, createdAtMs: 5, updatedAtMs: 5, contentHash: null, sourceTransport: 'cloud-direct', sourceEventId: 'greeting-response' },
      { id: 'message:report-request', sessionId, senderIdentityId: 'human:me', senderRole: 'user', messageKind: 'text', contentText: 'Create a report for a test case', content: { sender: 'Me', timeLabel: '15:28' }, status: 'sent', sequenceNum: 5, createdAtMs: 6, updatedAtMs: 6, contentHash: null, sourceTransport: 'cloud-direct', sourceEventId: 'report-request' },
      { id: 'message:report-response', sessionId, senderIdentityId: 'agent:local', senderRole: 'owned-agent', messageKind: 'agent-turn', contentText: 'Test Case Report', content: { sender: 'My Kordi', timeLabel: '15:29' }, status: 'complete', sequenceNum: 6, createdAtMs: 7, updatedAtMs: 7, contentHash: null, sourceTransport: 'cloud-direct', sourceEventId: 'report-response' },
    ],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  const sourceConversation = {
    id: `bridge:cloud:${KORDI_SUPPORT_AGENT_ID}:agent`,
    supportTicketEnabled: true,
    canonicalSessionId: sessionId,
    name: KORDI_SUPPORT_NAME,
    type: 'person',
    subtitle: 'Ask questions or suggest improvements',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: 'Person chat',
    participants: ['Me', KORDI_SUPPORT_NAME],
    collaborationTarget: {
      hostId: 'cloud',
      nodeId: KORDI_SUPPORT_AGENT_ID,
      displayName: KORDI_SUPPORT_NAME,
      runtime: 'kordi-desktop',
      agentId: KORDI_SUPPORT_AGENT_ID,
    },
    messages: [
      { id: 'runtime:report-request', role: 'user', sender: 'Me', text: 'Create a report for a test case', time: '15:28' },
      { id: 'runtime:report-response', role: 'owned-agent', sender: 'My Kordi', text: 'Test Case Report', time: '15:29' },
    ],
  };

  const conversation = readModel?.applyConversation(
    sourceConversation as never,
    (messages, fallback) => messages.at(-1)?.text ?? fallback ?? '',
  );

  assert.equal(conversation?.name, KORDI_SUPPORT_NAME);
  assert.equal(conversation?.type, 'person');
  assert.equal(conversation?.directness, 'Person chat');
  assert.deepEqual(conversation?.participants, ['Me', KORDI_SUPPORT_NAME]);
  assert.equal(conversation?.canonicalParticipants, undefined);
  assert.equal(conversation?.messages.length, 6);
  assert.deepEqual(
    conversation?.messages.map((message) => message.turn?.assistantText || message.text),
    [
      'Support routing verification',
      'Kordi Support is ready.',
      'hi',
      'Hi! Kordi Support is ready. How can I help?',
      'Create a report for a test case',
      'Test Case Report',
    ],
  );
  assert.equal(conversation?.messages[1]?.sender, KORDI_SUPPORT_NAME);
  assert.equal(conversation?.messages[1]?.sourceSenderLabel, KORDI_SUPPORT_NAME);
  assert.equal(conversation?.messages[1]?.role, 'external-agent');
  assert.equal(conversation?.messages[1]?.senderProfileImageUrl, KORDI_SUPPORT_AVATAR_URL);
  assert.equal(conversation?.profileImageUrl, KORDI_SUPPORT_AVATAR_URL);
  assert.equal(conversation?.participantProfileImageUrls?.[KORDI_SUPPORT_NAME], KORDI_SUPPORT_AVATAR_URL);
  assert.equal(conversation?.collaborationTarget?.agentId, KORDI_SUPPORT_AGENT_ID);

  const spaces = buildParticipantSpaces([conversation as never]);
  assert.equal(filterParticipantSpaces(spaces, '', 'contact')[0]?.title, KORDI_SUPPORT_NAME);
  assert.equal(filterParticipantSpaces(spaces, '', 'agent').length, 0);
});

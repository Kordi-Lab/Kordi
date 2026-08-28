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
import { normalizeSupportContactMessages } from '../src/features/support/supportConversationPresentation';

const sessionId = 'session:direct-agent:acct_me:cloud_agent_kordi_support';

test('support presentation hides stale local provider failures only', () => {
  const messages = normalizeSupportContactMessages([
    {
      id: 'provider-failure',
      role: 'owned-agent',
      sender: 'My Kordi',
      text: 'No provider configured yet.',
      detail: 'Open authentication',
      time: '12:46',
    },
    {
      id: 'support-answer',
      role: 'owned-agent',
      sender: 'My Kordi',
      text: '',
      time: '12:47',
      replyToMessageId: 'user-question',
      turn: {
        id: 'turn:support-answer',
        sessionId,
        prompt: 'Are you there?',
        status: 'complete',
        message: 'Complete',
        assistantText: 'Kordi Support is ready.',
        thinkingText: '',
        tools: [],
        completed: true,
        succeeded: true,
      },
    },
    {
      id: 'support-processing',
      role: 'external-agent',
      sender: KORDI_SUPPORT_NAME,
      text: '',
      time: '12:47',
      turn: {
        id: 'turn:support-processing',
        sessionId,
        prompt: 'Are you there?',
        status: 'processing',
        message: 'Processing…',
        assistantText: '',
        thinkingText: '',
        tools: [],
        completed: false,
        succeeded: false,
        replyToMessageId: 'user-question',
      },
    },
    {
      id: 'user-question',
      role: 'user',
      sender: 'Me',
      text: 'Why does another chat say no provider configured?',
      time: '12:48',
    },
  ]);

  assert.deepEqual(messages.map((message) => message.id), ['support-answer', 'support-processing', 'user-question']);
  assert.equal(messages[0]?.sender, KORDI_SUPPORT_NAME);
  assert.equal(messages[0]?.role, 'person');
  assert.equal(messages[0]?.senderType, 'human');
  assert.equal(messages[0]?.text, 'Kordi Support is ready.');
  assert.equal(messages[0]?.turn, undefined);
  assert.equal(messages[0]?.replyToMessageId, undefined);
  assert.equal(messages[0]?.supportContactResponse, true);
  assert.equal(messages[0]?.supportContactTyping, false);
  assert.equal(messages[1]?.sender, KORDI_SUPPORT_NAME);
  assert.equal(messages[1]?.role, 'person');
  assert.equal(messages[1]?.senderType, 'human');
  assert.equal(messages[1]?.text, '');
  assert.equal(messages[1]?.turn, undefined);
  assert.equal(messages[1]?.replyToMessageId, undefined);
  assert.equal(messages[1]?.supportContactResponse, true);
  assert.equal(messages[1]?.supportContactTyping, true);
});

test('support presentation drops orphaned processing without a user request', () => {
  const messages = normalizeSupportContactMessages([{
    id: 'orphaned-support-processing',
    role: 'owned-agent',
    sender: 'My Kordi',
    text: '',
    time: '16:40',
    turn: {
      id: 'turn:orphaned-support-processing',
      sessionId,
      prompt: '',
      status: 'processing',
      message: 'Processing…',
      assistantText: '',
      thinkingText: '',
      tools: [],
      completed: false,
      succeeded: false,
    },
  }]);

  assert.deepEqual(messages, []);
});

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
      { id: 'runtime:latest-request', role: 'user', sender: 'Me', text: 'Can you still hear me?', time: '15:30' },
      { id: 'runtime:latest-response', role: 'person', sender: KORDI_SUPPORT_NAME, text: 'Yes, I can.', time: '15:30' },
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
  assert.equal(conversation?.messages.length, 8);
  assert.deepEqual(
    conversation?.messages.map((message) => message.turn?.assistantText || message.text),
    [
      'Support routing verification',
      'Kordi Support is ready.',
      'hi',
      'Hi! Kordi Support is ready. How can I help?',
      'Create a report for a test case',
      'Test Case Report',
      'Can you still hear me?',
      'Yes, I can.',
    ],
  );
  assert.equal(conversation?.messages[1]?.sender, KORDI_SUPPORT_NAME);
  assert.equal(conversation?.messages[1]?.sourceSenderLabel, KORDI_SUPPORT_NAME);
  assert.equal(conversation?.messages[1]?.role, 'person');
  assert.equal(conversation?.messages[1]?.senderType, 'human');
  assert.equal(conversation?.messages[1]?.turn, undefined);
  assert.equal(conversation?.messages[1]?.supportContactResponse, true);
  assert.equal(conversation?.messages[1]?.senderProfileImageUrl, KORDI_SUPPORT_AVATAR_URL);
  assert.equal(conversation?.profileImageUrl, KORDI_SUPPORT_AVATAR_URL);
  assert.equal(conversation?.participantProfileImageUrls?.[KORDI_SUPPORT_NAME], KORDI_SUPPORT_AVATAR_URL);
  assert.equal(conversation?.collaborationTarget?.agentId, KORDI_SUPPORT_AGENT_ID);

  const spaces = buildParticipantSpaces([conversation as never]);
  assert.equal(filterParticipantSpaces(spaces, '', 'contact')[0]?.title, KORDI_SUPPORT_NAME);
  assert.equal(filterParticipantSpaces(spaces, '', 'agent').length, 0);

  const scopedDraftSessionId = 'session:direct-system-agent:acct_me:cloud_agent_kordi_support';
  const scopedDraft = {
    ...sourceConversation,
    id: `cloud:conversation:acct_real_support_owner:agent:session:${encodeURIComponent(scopedDraftSessionId)}`,
    canonicalSessionId: scopedDraftSessionId,
    subtitle: `cloud:conversation:acct_real_support_owner:agent:session:${encodeURIComponent(scopedDraftSessionId)}`,
    messages: [],
    _updatedAtMs: 10,
  };
  const collapsed = readModel?.buildChatConversations(
    [sourceConversation as never, scopedDraft as never],
    (messages, fallback) => messages.at(-1)?.text ?? fallback ?? '',
  ) ?? [];

  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0]?.name, KORDI_SUPPORT_NAME);
  assert.equal(collapsed[0]?.messages.length, 8);
  assert.notEqual(collapsed[0]?.id, scopedDraft.id);
});

test('canonical hydration keeps runtime Kordi Support visible before its session materializes', () => {
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
    identities: [],
    sessions: [],
    participants: [],
    messages: [],
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  } as never);

  const runtimeSupportConversation = {
    id: `cloud:conversation:acct_real_support_owner:agent:session:${encodeURIComponent('session:direct-system-agent:acct_me:cloud_agent_kordi_support')}`,
    supportTicketEnabled: true,
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    name: KORDI_SUPPORT_NAME,
    type: 'external-agent',
    subtitle: 'Hi! How can I help?',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: 'Agent chat',
    participants: ['Me', KORDI_SUPPORT_NAME],
    collaborationTarget: {
      hostId: 'cloud',
      nodeId: 'acct_real_support_owner',
      displayName: KORDI_SUPPORT_NAME,
      runtime: 'kordi-desktop',
      agentId: KORDI_SUPPORT_AGENT_ID,
    },
    messages: [
      { id: 'runtime:greeting', role: 'user', sender: 'Me', text: 'hi', time: '11:35' },
      {
        id: 'runtime:greeting-response',
        role: 'external-agent',
        sender: KORDI_SUPPORT_NAME,
        text: '',
        time: '11:35',
        turn: {
          id: 'turn:greeting-response',
          sessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
          prompt: '',
          status: 'complete',
          message: 'Complete',
          assistantText: 'Hi! How can I help?',
          thinkingText: '',
          tools: [],
          completed: true,
          succeeded: true,
          error: null,
        },
      },
    ],
  };

  const conversations = readModel?.buildChatConversations(
    [runtimeSupportConversation as never],
    (messages, fallback) => messages.at(-1)?.turn?.assistantText || messages.at(-1)?.text || fallback || '',
  ) ?? [];

  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]?.id, runtimeSupportConversation.id);
  assert.equal(conversations[0]?.name, KORDI_SUPPORT_NAME);
  assert.equal(conversations[0]?.type, 'person');
  assert.equal(conversations[0]?.directness, 'Person chat');
  assert.deepEqual(
    conversations[0]?.messages.map((message) => message.turn?.assistantText || message.text),
    ['hi', 'Hi! How can I help?'],
  );
  assert.equal(conversations[0]?.messages[1]?.role, 'person');
  assert.equal(conversations[0]?.messages[1]?.turn, undefined);
  assert.equal(conversations[0]?.messages[1]?.supportContactResponse, true);
});

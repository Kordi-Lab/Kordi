import { encodeCloudGroupControl } from '../../src/features/cloud/cloudGroupMessages';
import type { CloudGroupParticipant } from '../../src/features/cloud/cloudGroupMessages';
import type { CloudMessage, CloudMessageAttachment } from '../../src/features/cloud/authClient';
import type {
  CanonicalSessionMessage,
  CanonicalSessionState,
  DesktopCollaborationConversation,
  DesktopCollaborationConversationMessage,
} from '../../src/kordi-app/types';

export const CHAT_SCALE = {
  spaces: 200,
  sessions: 200,
  messagesPerSession: 100,
  selectedSessionMessages: 1_000,
  cloudRecipients: 20,
} as const;

export const SCALE_ACCOUNT_ID = 'acct_me';

const SCALE_START_MS = Date.parse('2026-01-01T00:00:00.000Z');
const SCALE_HUMAN_ID = 'human:scale:self';
const SCALE_AGENT_ID = 'agent:scale:self';

export const scaleSessionId = (sessionIndex: number) =>
  `session:group:scale-${sessionIndex}`;

export const scaleMessageId = (sessionIndex: number, messageIndex: number) =>
  `message:scale:${sessionIndex}:${messageIndex}`;

export function scaleMessageCount() {
  return CHAT_SCALE.sessions * CHAT_SCALE.messagesPerSession
    + CHAT_SCALE.selectedSessionMessages;
}

function scaleTimestampMs(sessionIndex: number, messageIndex: number) {
  return SCALE_START_MS + sessionIndex * 2_000_000 + messageIndex * 1_000;
}

function scaleAttachment(messageId: string): CloudMessageAttachment {
  return {
    attachmentId: `attachment:${messageId}`,
    name: `${messageId}.png`,
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 24_000,
    downloadUrl: `https://scale.invalid/${encodeURIComponent(messageId)}.png`,
  };
}

function scaleCanonicalMessage(sessionIndex: number, messageIndex: number): CanonicalSessionMessage {
  const id = scaleMessageId(sessionIndex, messageIndex);
  const sessionId = scaleSessionId(sessionIndex);
  const isAgent = messageIndex % 2 === 1;
  const agentOrdinal = isAgent ? Math.floor(messageIndex / 2) : -1;
  const pairPosition = agentOrdinal >= 0 ? agentOrdinal % 20 : -1;
  const isProcessing = isAgent && pairPosition === 0;
  const isTerminalAfterProcessing = isAgent && pairPosition === 1;
  const requestMessageIndex = isProcessing
    ? messageIndex - 1
    : isTerminalAfterProcessing
      ? messageIndex - 3
      : Math.max(0, messageIndex - 1);
  const requestId = scaleMessageId(sessionIndex, requestMessageIndex);
  const createdAtMs = scaleTimestampMs(sessionIndex, messageIndex);
  const hasRichThinking = isAgent && agentOrdinal % 10 === 0;
  const attachments = messageIndex % 15 === 0 ? [scaleAttachment(id)] : undefined;
  const deliveryState = isProcessing ? 'processing' : 'complete';

  return {
    id,
    sessionId,
    senderIdentityId: isAgent ? SCALE_AGENT_ID : SCALE_HUMAN_ID,
    senderRole: isAgent ? 'owned-agent' : 'user',
    messageKind: isAgent ? 'agent-turn' : 'text',
    contentText: isProcessing
      ? 'processing...'
      : isAgent
        ? `Scale agent response ${messageIndex}`
        : `Scale user message ${messageIndex}`,
    content: {
      sender: isAgent ? 'My Kordi' : 'Me',
      deliveryState,
      ...(isAgent ? { requestId, replyToMessageId: requestId } : {}),
      ...(hasRichThinking ? {
        thinkingText: 't'.repeat(900),
        tools: [
          { id: `tool:${id}:0`, name: 'search', status: 'done', arguments: '{}', liveOutput: '', resultText: 'done' },
          { id: `tool:${id}:1`, name: 'read', status: 'done', arguments: '{}', liveOutput: '', resultText: 'done' },
        ],
      } : {}),
      ...(attachments ? { attachments } : {}),
    },
    parentMessageId: isAgent ? requestId : null,
    delegatedExchangeId: null,
    status: isProcessing ? 'processing' : 'complete',
    sequenceNum: messageIndex + 1,
    createdAtMs,
    updatedAtMs: createdAtMs,
    contentHash: null,
    sourceTransport: 'scale-fixture',
    sourceEventId: `scale-fixture:${id}`,
  };
}

export function buildScaleCanonicalState(): CanonicalSessionState {
  const sessions = Array.from({ length: CHAT_SCALE.sessions }, (_, sessionIndex) => {
    const lastMessageIndex = sessionIndex === 0
      ? CHAT_SCALE.messagesPerSession + CHAT_SCALE.selectedSessionMessages - 1
      : CHAT_SCALE.messagesPerSession - 1;
    const createdAtMs = scaleTimestampMs(sessionIndex, 0);
    const lastMessageAtMs = scaleTimestampMs(sessionIndex, lastMessageIndex);
    return {
      id: scaleSessionId(sessionIndex),
      kind: 'group',
      title: `Scale group ${sessionIndex}`,
      status: 'active',
      createdByIdentityId: SCALE_HUMAN_ID,
      primaryIdentityId: SCALE_AGENT_ID,
      metadata: { groupSpaceId: `space:scale:${sessionIndex}` },
      createdAtMs,
      updatedAtMs: lastMessageAtMs,
      lastMessageAtMs,
    };
  });

  const participants = sessions.flatMap((session, sessionIndex) => {
    const finalMessageIndex = sessionIndex === 0
      ? CHAT_SCALE.messagesPerSession + CHAT_SCALE.selectedSessionMessages - 1
      : CHAT_SCALE.messagesPerSession - 1;
    return [
      {
        sessionId: session.id,
        identityId: SCALE_HUMAN_ID,
        role: 'self',
        state: 'active',
        addedByIdentityId: SCALE_HUMAN_ID,
        addedAtMs: session.createdAtMs,
        lastSeenAtMs: session.lastMessageAtMs,
        lastReadMessageId: scaleMessageId(sessionIndex, finalMessageIndex),
      },
      {
        sessionId: session.id,
        identityId: SCALE_AGENT_ID,
        role: 'owned-agent',
        state: 'active',
        addedByIdentityId: SCALE_HUMAN_ID,
        addedAtMs: session.createdAtMs,
        lastSeenAtMs: session.lastMessageAtMs,
        lastReadMessageId: null,
      },
    ];
  });

  const messages: CanonicalSessionMessage[] = [];
  for (let sessionIndex = 0; sessionIndex < CHAT_SCALE.sessions; sessionIndex += 1) {
    for (let messageIndex = 0; messageIndex < CHAT_SCALE.messagesPerSession; messageIndex += 1) {
      messages.push(scaleCanonicalMessage(sessionIndex, messageIndex));
    }
  }
  for (
    let messageIndex = CHAT_SCALE.messagesPerSession;
    messageIndex < CHAT_SCALE.messagesPerSession + CHAT_SCALE.selectedSessionMessages;
    messageIndex += 1
  ) {
    messages.push(scaleCanonicalMessage(0, messageIndex));
  }

  if (sessions.length !== CHAT_SCALE.sessions) {
    throw new Error(`Scale fixture session mismatch: ${sessions.length}`);
  }
  if (messages.length !== scaleMessageCount()) {
    throw new Error(`Scale fixture message mismatch: ${messages.length}`);
  }

  return {
    storagePath: 'scale-fixture',
    profile: {
      id: 'profile:scale',
      displayName: 'Scale user',
      humanIdentityId: SCALE_HUMAN_ID,
      activeAgentIdentityId: SCALE_AGENT_ID,
      storageRoot: 'scale-fixture',
      createdAtMs: SCALE_START_MS,
      updatedAtMs: SCALE_START_MS,
    },
    identities: [
      {
        id: SCALE_HUMAN_ID,
        kind: 'human',
        displayName: 'Scale user',
        source: 'local',
        avatarKey: 'scale-user',
        createdAtMs: SCALE_START_MS,
        updatedAtMs: SCALE_START_MS,
      },
      {
        id: SCALE_AGENT_ID,
        kind: 'agent',
        displayName: 'My Kordi',
        ownerIdentityId: SCALE_HUMAN_ID,
        source: 'local',
        avatarKey: 'scale-agent',
        createdAtMs: SCALE_START_MS,
        updatedAtMs: SCALE_START_MS,
      },
    ],
    sessions,
    participants,
    messages,
    delegatedExchanges: [],
    presence: [],
    contextSnapshots: [],
  };
}

export function buildScaleCloudMessagesByPeer(): Record<string, CloudMessage[]> {
  const peerIds = Array.from(
    { length: CHAT_SCALE.cloudRecipients },
    (_, index) => `acct_scale_${index}`,
  );
  const participants: CloudGroupParticipant[] = [
    { accountId: SCALE_ACCOUNT_ID, displayName: 'Me', avatarUrl: null, role: 'admin' },
    ...peerIds.map((accountId, index) => ({
      accountId,
      displayName: `Peer ${index}`,
      avatarUrl: null,
      role: 'person' as const,
    })),
  ];
  const bodies = Array.from({ length: CHAT_SCALE.selectedSessionMessages }, (_, selectedIndex) => {
    const messageIndex = CHAT_SCALE.messagesPerSession + selectedIndex;
    const id = scaleMessageId(0, messageIndex);
    const isAgent = messageIndex % 2 === 1;
    const agentOrdinal = isAgent ? Math.floor(messageIndex / 2) : -1;
    const pairPosition = agentOrdinal >= 0 ? agentOrdinal % 20 : -1;
    const isProcessing = isAgent && pairPosition === 0;
    const isTerminalAfterProcessing = isAgent && pairPosition === 1;
    const requestIndex = isProcessing
      ? messageIndex - 1
      : isTerminalAfterProcessing
        ? messageIndex - 3
        : Math.max(0, messageIndex - 1);
    const attachments = messageIndex % 15 === 0 ? [scaleAttachment(id)] : undefined;

    return encodeCloudGroupControl({
      kind: 'group-message',
      groupId: scaleSessionId(0),
      groupSpaceId: 'space:scale:0',
      groupTitle: 'Scale group 0',
      createdByAccountId: SCALE_ACCOUNT_ID,
      actor: participants[0],
      participants,
      message: {
        id,
        senderAccountId: SCALE_ACCOUNT_ID,
        text: isProcessing ? 'processing...' : `Scale Cloud message ${messageIndex}`,
        createdAtMs: SCALE_START_MS + selectedIndex * 1_000,
        senderKind: isAgent ? 'agent' : 'human',
        senderDisplayName: isAgent ? 'My Kordi' : 'Me',
        deliveryState: isProcessing ? 'processing' : 'complete',
        ...(isAgent ? {
          requestId: scaleMessageId(0, requestIndex),
          replyToMessageId: scaleMessageId(0, requestIndex),
        } : {}),
        ...(attachments ? { attachments } : {}),
      },
    });
  });

  const result: Record<string, CloudMessage[]> = {};
  peerIds.forEach((peerId, peerIndex) => {
    result[peerId] = bodies.map((body, selectedIndex) => {
      const createdAtMs = SCALE_START_MS + selectedIndex * 1_000;
      const fanoutIndex = selectedIndex * CHAT_SCALE.cloudRecipients + peerIndex;
      return {
        messageId: `wire:scale:${selectedIndex}:${peerIndex}`,
        fromAccountId: SCALE_ACCOUNT_ID,
        toAccountId: peerId,
        body,
        createdAt: new Date(createdAtMs).toISOString(),
        deliveredAt: new Date(createdAtMs + 1_000).toISOString(),
        readAt: fanoutIndex % 3 === 0 ? new Date(createdAtMs + 2_000).toISOString() : null,
        direction: 'outgoing',
        sessionId: scaleSessionId(0),
      };
    });
  });

  const fanoutCount = Object.values(result).reduce((count, messages) => count + messages.length, 0);
  const expectedFanoutCount = CHAT_SCALE.selectedSessionMessages * CHAT_SCALE.cloudRecipients;
  if (fanoutCount !== expectedFanoutCount) {
    throw new Error(`Scale fixture Cloud fanout mismatch: ${fanoutCount}`);
  }
  return result;
}

export function buildScaleCollaborationConversation(): DesktopCollaborationConversation {
  const messages: DesktopCollaborationConversationMessage[] = Array.from(
    { length: CHAT_SCALE.selectedSessionMessages },
    (_, index) => {
      const blockIndex = Math.floor(index / 20);
      const blockPosition = index % 20;
      const requestId = `bridge-request:${blockIndex}`;
      const timestampMs = SCALE_START_MS + index * 1_000;
      if (blockPosition === 0) {
        return {
          id: `collaboration-message:${index}`,
          direction: 'outbound',
          sender: 'Me',
          text: `Scale request ${blockIndex}`,
          timeLabel: '00:00',
          timestampMs,
          requestId,
          deliveryState: 'delivered',
        };
      }
      if (blockPosition === 1) {
        return {
          id: `collaboration-message:${index}`,
          direction: 'inbound-response',
          sender: 'Scale agent',
          text: 'processing...',
          timeLabel: '00:00',
          timestampMs,
          requestId,
          deliveryState: 'processing',
        };
      }
      if (blockPosition === 2) {
        return {
          id: `collaboration-message:${index}`,
          direction: 'inbound-response',
          sender: 'Scale agent',
          text: `Scale response ${blockIndex}`,
          timeLabel: '00:00',
          timestampMs,
          requestId,
          deliveryState: 'responded',
        };
      }
      return {
        id: `collaboration-message:${index}`,
        direction: index % 2 === 0 ? 'outbound' : 'inbound-response',
        sender: index % 2 === 0 ? 'Me' : 'Scale agent',
        text: `Scale transcript row ${index}`,
        timeLabel: '00:00',
        timestampMs,
        deliveryState: index % 2 === 0 ? 'delivered' : 'responded',
      };
    },
  );

  return {
    id: 'bridge:scale',
    canonicalSessionId: scaleSessionId(0),
    hostId: 'scale-host',
    peerNodeId: 'scale-peer',
    peerDisplayName: 'Scale agent',
    peerOwnerName: 'Scale peer',
    peerRuntime: 'kordi-agent',
    title: 'Scale agent',
    subtitle: 'Scale fixture',
    unreadCount: 0,
    updatedAtMs: SCALE_START_MS + CHAT_SCALE.selectedSessionMessages * 1_000,
    updatedAtLabel: '00:00',
    awaitingReply: false,
    peerTyping: false,
    messages,
  };
}

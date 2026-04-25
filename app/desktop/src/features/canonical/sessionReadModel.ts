import type {
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionParticipant,
  CanonicalSessionState,
  Conversation,
  ConversationParticipant,
  DesktopChatToolSnapshot,
  Message,
  MessageAttachment,
} from '@/kordi-app/types';
import { formatDesktopClockTime } from '@/lib/time';

type CanonicalConversationLike = {
  id: string;
  canonicalSessionId?: string;
  canonicalStoragePath?: string;
  canonicalParticipantCount?: number;
  canonicalMessageCount?: number;
  canonicalDelegatedExchangeCount?: number;
  canonicalContextSnapshotCount?: number;
  canonicalPresenceSummary?: string;
  canonicalParticipants?: ConversationParticipant[];
  updatedAtLabel?: string;
  name: string;
  subtitle: string;
  participants: string[];
  messages: Message[];
};

type ConversationSubtitleBuilder = (messages: Message[], fallback?: string) => string;

type CanonicalIndexes = {
  storagePath: string;
  profileHumanIdentityId?: string | null;
  sessionById: Map<string, CanonicalSessionState['sessions'][number]>;
  identityById: Map<string, CanonicalIdentity>;
  presenceByIdentityId: Map<string, CanonicalSessionState['presence'][number]>;
  participantsBySessionId: Map<string, CanonicalSessionParticipant[]>;
  canonicalParticipantsBySessionId: Map<string, ConversationParticipant[]>;
  canonicalMessagesBySessionId: Map<string, Message[]>;
  rawMessageCountBySessionId: Map<string, number>;
  delegatedExchangeCountBySessionId: Map<string, number>;
  contextSnapshotCountBySessionId: Map<string, number>;
  presenceSummaryBySessionId: Map<string, string>;
};

function emptyIndexes(): CanonicalIndexes {
  return {
    storagePath: '',
    profileHumanIdentityId: null,
    sessionById: new Map(),
    identityById: new Map(),
    presenceByIdentityId: new Map(),
    participantsBySessionId: new Map(),
    canonicalParticipantsBySessionId: new Map(),
    canonicalMessagesBySessionId: new Map(),
    rawMessageCountBySessionId: new Map(),
    delegatedExchangeCountBySessionId: new Map(),
    contextSnapshotCountBySessionId: new Map(),
    presenceSummaryBySessionId: new Map(),
  };
}

function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function canonicalAttachments(value: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const attachments = value.flatMap((item) => {
    const record = contentRecord(item);
    const name = stringValue(record.name);
    const rawKind = stringValue(record.kind);
    if (!name || (rawKind !== 'image' && rawKind !== 'file')) return [];

    const kind: MessageAttachment['kind'] = rawKind;
    return [{
      kind,
      name,
      formatLabel: stringValue(record.formatLabel) ?? null,
      previewUrl: stringValue(record.previewUrl) ?? null,
      mimeType: stringValue(record.mimeType) ?? null,
    }];
  });

  return attachments.length > 0 ? attachments : undefined;
}

function canonicalTools(value: unknown): DesktopChatToolSnapshot[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item, index) => {
    const record = contentRecord(item);
    const name = stringValue(record.name);
    if (!name) return [];

    return [{
      id: stringValue(record.id) ?? `canonical-tool-${index}`,
      name,
      status: stringValue(record.status) ?? 'done',
      arguments: stringValue(record.arguments) ?? '',
      liveOutput: stringValue(record.liveOutput) ?? '',
      resultText: stringValue(record.resultText) ?? null,
      detail: stringValue(record.detail) ?? null,
      isError: Boolean(record.isError),
    }];
  });
}

function canonicalMessageRole(message: CanonicalSessionMessage, identity?: CanonicalIdentity): Message['role'] {
  if (['system', 'user', 'owned-agent', 'external-agent', 'person'].includes(message.senderRole)) {
    return message.senderRole as Message['role'];
  }
  if (identity?.kind === 'agent') return identity.source === 'local' ? 'owned-agent' : 'external-agent';
  return 'person';
}

function canonicalMessageIsComplete(message: CanonicalSessionMessage, content: Record<string, unknown>) {
  const status = message.status.toLowerCase();
  const deliveryState = stringValue(content.deliveryState)?.toLowerCase();
  return !['draft', 'sending', 'processing'].includes(status) && deliveryState !== 'processing';
}

function mapCanonicalMessage(
  message: CanonicalSessionMessage,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
): Message | null {
  const content = contentRecord(message.content);
  const identity = identityById.get(message.senderIdentityId);
  const role = canonicalMessageRole(message, identity);
  const isAgentTurn = message.messageKind === 'agent-turn' || role === 'owned-agent' || role === 'external-agent';
  const completed = canonicalMessageIsComplete(message, content);
  const failed = message.status === 'failed' || stringValue(content.deliveryState) === 'failed';
  const tools = canonicalTools(content.tools);
  const time = stringValue(content.timeLabel) ?? formatDesktopClockTime(message.createdAtMs);
  const sender = stringValue(content.sender) || identity?.displayName;
  const thinkingText = stringValue(content.thinkingText) ?? '';

  if (role === 'system' && !message.contentText.trim()) return null;

  return {
    role,
    sender,
    senderType: identity?.kind === 'agent' ? 'agent' : 'human',
    senderProfileImageUrl: identity?.profileImageUrl ?? null,
    senderAvatarSeed: identity?.avatarKey ?? null,
    isOwnMessage: role === 'user' || message.senderIdentityId === profileHumanIdentityId,
    showSenderMeta: role === 'person' || role === 'external-agent',
    text: isAgentTurn ? '' : message.contentText,
    time,
    detail: stringValue(content.detail),
    attachments: canonicalAttachments(content.attachments),
    statusChips: role === 'user' && message.status !== 'sent' ? [message.status] : undefined,
    turn: isAgentTurn
      ? {
          id: `canonical-turn:${message.id}`,
          sessionId: message.sessionId,
          prompt: '',
          status: completed ? (failed ? 'failed' : 'complete') : (message.contentText.trim() ? 'writing' : 'typing'),
          message: completed ? (failed ? 'Failed' : 'Complete') : (message.contentText.trim() ? 'Replying…' : 'Typing…'),
          assistantText: message.contentText,
          thinkingText,
          tools,
          completed,
          succeeded: completed && !failed && tools.every((tool) => !tool.isError),
          error: failed ? stringValue(content.error) ?? 'Message failed' : null,
        }
      : undefined,
  };
}

function buildCanonicalIndexes(canonicalState: CanonicalSessionState | null): CanonicalIndexes {
  if (!canonicalState) return emptyIndexes();

  const identityById = new Map(canonicalState.identities.map((identity) => [identity.id, identity]));
  const sessionById = new Map(canonicalState.sessions.map((session) => [session.id, session]));
  const presenceByIdentityId = new Map(canonicalState.presence.map((presence) => [presence.identityId, presence]));

  const participantsBySessionId = new Map<string, CanonicalSessionParticipant[]>();
  for (const participant of canonicalState.participants) {
    participantsBySessionId.set(participant.sessionId, [...(participantsBySessionId.get(participant.sessionId) ?? []), participant]);
  }

  const canonicalParticipantsBySessionId = new Map<string, ConversationParticipant[]>();
  for (const [sessionId, participants] of participantsBySessionId) {
    const details = participants.flatMap((participant) => {
      const identity = identityById.get(participant.identityId);
      if (!identity) return [];
      const presence = presenceByIdentityId.get(identity.id);
      return [{
        id: identity.id,
        name: identity.displayName,
        kind: identity.kind,
        role: participant.role,
        source: identity.source,
        bridgeNodeId: identity.bridgeNodeId,
        humanId: identity.humanId,
        agentId: identity.agentId,
        avatarKey: identity.avatarKey,
        profileImageUrl: identity.profileImageUrl,
        presenceStatus: presence?.status ?? null,
        presenceDetail: presence?.detail ?? null,
      }];
    });
    canonicalParticipantsBySessionId.set(sessionId, details);
  }

  const rawMessagesBySessionId = new Map<string, CanonicalSessionMessage[]>();
  for (const message of canonicalState.messages) {
    rawMessagesBySessionId.set(message.sessionId, [...(rawMessagesBySessionId.get(message.sessionId) ?? []), message]);
  }

  const canonicalMessagesBySessionId = new Map<string, Message[]>();
  const rawMessageCountBySessionId = new Map<string, number>();
  for (const [sessionId, messages] of rawMessagesBySessionId) {
    const sortedMessages = [...messages].sort((left, right) => left.sequenceNum - right.sequenceNum || left.createdAtMs - right.createdAtMs);
    rawMessageCountBySessionId.set(sessionId, sortedMessages.length);
    canonicalMessagesBySessionId.set(
      sessionId,
      sortedMessages.flatMap((message) => {
        const mapped = mapCanonicalMessage(message, identityById, canonicalState.profile.humanIdentityId);
        return mapped ? [mapped] : [];
      }),
    );
  }

  const delegatedExchangeCountBySessionId = new Map<string, number>();
  for (const exchange of canonicalState.delegatedExchanges) {
    delegatedExchangeCountBySessionId.set(exchange.sessionId, (delegatedExchangeCountBySessionId.get(exchange.sessionId) ?? 0) + 1);
  }

  const contextSnapshotCountBySessionId = new Map<string, number>();
  for (const snapshot of canonicalState.contextSnapshots) {
    contextSnapshotCountBySessionId.set(snapshot.sessionId, (contextSnapshotCountBySessionId.get(snapshot.sessionId) ?? 0) + 1);
  }

  const presenceSummaryBySessionId = new Map<string, string>();
  for (const [sessionId, participants] of canonicalParticipantsBySessionId) {
    const counts = participants.reduce<Record<string, number>>((acc, participant) => {
      const status = participant.presenceStatus?.trim();
      if (!status || status === 'offline') return acc;
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});

    if (Object.keys(counts).length > 0) {
      presenceSummaryBySessionId.set(
        sessionId,
        Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(' • '),
      );
    }
  }

  return {
    storagePath: canonicalState.storagePath,
    profileHumanIdentityId: canonicalState.profile.humanIdentityId,
    sessionById,
    identityById,
    presenceByIdentityId,
    participantsBySessionId,
    canonicalParticipantsBySessionId,
    canonicalMessagesBySessionId,
    rawMessageCountBySessionId,
    delegatedExchangeCountBySessionId,
    contextSnapshotCountBySessionId,
    presenceSummaryBySessionId,
  };
}

function shouldUseCanonicalMessages(existingMessages: Message[], canonicalMessages: Message[]) {
  if (canonicalMessages.length === 0) return false;
  if (existingMessages.some((message) => message.turn && !message.turn.completed)) return false;

  const placeholderOnly = existingMessages.length === 1
    && existingMessages[0]?.role === 'system'
    && /^(Draft session|Session ready|Opening your local chat history|Select a local session)/.test(existingMessages[0]?.text ?? '');

  return placeholderOnly || canonicalMessages.length >= existingMessages.length;
}

export type CanonicalSessionReadModel = {
  sessionTitle: (sessionId: string, fallback: string) => string;
  participantNames: (sessionId: string, fallback: string[]) => string[];
  participantDetails: (sessionId: string) => ConversationParticipant[];
  messages: (sessionId: string) => Message[];
  preferMessages: (sessionId: string, existingMessages: Message[]) => Message[];
  applyConversation: <T extends CanonicalConversationLike>(
    conversation: T,
    buildSubtitle: ConversationSubtitleBuilder,
  ) => T;
  buildChatConversations: (conversations: Conversation[], buildSubtitle: ConversationSubtitleBuilder) => Conversation[];
};

export type CanonicalConversationLookupTarget = {
  humanId?: string | null;
  agentId?: string | null;
  bridgeNodeId?: string | null;
};

export function findCanonicalConversationForTarget(
  conversations: Conversation[],
  target: CanonicalConversationLookupTarget,
): Conversation | null {
  const normalizedHumanId = target.humanId?.trim();
  const normalizedAgentId = target.agentId?.trim();
  const normalizedBridgeNodeId = target.bridgeNodeId?.trim();

  let bestMatch: { rank: number; conversation: Conversation } | null = null;
  for (const conversation of conversations) {
    const participants = conversation.canonicalParticipants ?? [];
    if (participants.length === 0) continue;

    let rank = Number.POSITIVE_INFINITY;
    if (normalizedAgentId && participants.some((participant) => participant.agentId === normalizedAgentId)) {
      rank = conversation.directness === 'Direct chat' ? 0 : 1;
    } else if (normalizedHumanId && participants.some((participant) => participant.humanId === normalizedHumanId)) {
      rank = conversation.directness === 'Direct chat' ? 0 : 1;
    } else if (normalizedBridgeNodeId && participants.some((participant) => participant.bridgeNodeId === normalizedBridgeNodeId)) {
      rank = conversation.directness === 'Direct chat' ? 2 : 3;
    }

    if (!Number.isFinite(rank)) continue;
    if (!bestMatch || rank < bestMatch.rank) {
      bestMatch = { rank, conversation };
    }
  }

  return bestMatch?.conversation ?? null;
}

export function createCanonicalSessionReadModel(canonicalState: CanonicalSessionState | null): CanonicalSessionReadModel | null {
  if (!canonicalState) return null;

  const indexes = buildCanonicalIndexes(canonicalState);
  const chatSessionIds = canonicalState.sessions
    .filter((session) => session.kind !== 'project')
    .sort((left, right) => {
      const leftTs = left.lastMessageAtMs ?? left.updatedAtMs ?? left.createdAtMs;
      const rightTs = right.lastMessageAtMs ?? right.updatedAtMs ?? right.createdAtMs;
      return rightTs - leftTs;
    })
    .map((session) => session.id);

  return {
    sessionTitle(sessionId, fallback) {
      return indexes.sessionById.get(sessionId)?.title || fallback;
    },
    participantNames(sessionId, fallback) {
      const names = (indexes.canonicalParticipantsBySessionId.get(sessionId) ?? []).map((participant) => participant.name);
      return names.length > 0 ? names : fallback;
    },
    participantDetails(sessionId) {
      return indexes.canonicalParticipantsBySessionId.get(sessionId) ?? [];
    },
    messages(sessionId) {
      return indexes.canonicalMessagesBySessionId.get(sessionId) ?? [];
    },
    preferMessages(sessionId, existingMessages) {
      const canonicalMessages = indexes.canonicalMessagesBySessionId.get(sessionId) ?? [];
      return shouldUseCanonicalMessages(existingMessages, canonicalMessages) ? canonicalMessages : existingMessages;
    },
    applyConversation(conversation, buildSubtitle) {
      const sessionId = conversation.canonicalSessionId ?? conversation.id;
      const session = indexes.sessionById.get(sessionId);
      if (!session) return conversation;

      const messages = this.preferMessages(sessionId, conversation.messages);
      const participants = this.participantNames(sessionId, conversation.participants);
      const canonicalParticipants = this.participantDetails(sessionId);
      const latestTime = messages[messages.length - 1]?.time
        ?? conversation.updatedAtLabel
        ?? formatDesktopClockTime(session.lastMessageAtMs ?? session.updatedAtMs ?? session.createdAtMs);

      return {
        ...conversation,
        canonicalSessionId: sessionId,
        canonicalStoragePath: indexes.storagePath,
        name: session.title || conversation.name,
        subtitle: buildSubtitle(messages, conversation.subtitle),
        participants,
        canonicalParticipants: canonicalParticipants.length > 0 ? canonicalParticipants : undefined,
        messages,
        updatedAtLabel: latestTime,
        canonicalParticipantCount: (indexes.participantsBySessionId.get(sessionId) ?? []).length,
        canonicalMessageCount: indexes.rawMessageCountBySessionId.get(sessionId) ?? 0,
        canonicalDelegatedExchangeCount: indexes.delegatedExchangeCountBySessionId.get(sessionId) ?? 0,
        canonicalContextSnapshotCount: indexes.contextSnapshotCountBySessionId.get(sessionId) ?? 0,
        canonicalPresenceSummary: indexes.presenceSummaryBySessionId.get(sessionId),
      };
    },
    buildChatConversations(conversations, buildSubtitle) {
      const sourceBySessionId = new Map(conversations.map((conversation) => [conversation.canonicalSessionId ?? conversation.id, conversation]));
      const hydrated = chatSessionIds
        .flatMap((sessionId) => {
          const source = sourceBySessionId.get(sessionId);
          return source ? [this.applyConversation(source, buildSubtitle)] : [];
        });
      const hydratedIds = new Set(hydrated.map((conversation) => conversation.id));
      const extras = conversations.filter((conversation) => !hydratedIds.has(conversation.id));
      return [...hydrated, ...extras];
    },
  };
}

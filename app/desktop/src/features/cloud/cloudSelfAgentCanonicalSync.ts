import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionMessage,
  CanonicalSessionState,
  MessageActionMetadata,
  OpenCanonicalSessionRequest,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudMessage,
  CloudSessionForkSummary,
  CloudSessionTitle,
} from './authClient';
import {
  parseCloudAgentCancel,
  parseCloudAgentResponse,
} from './cloudAgentMessages';
import {
  cloudDirectMessageAction,
  cloudDirectMessageDisplayText,
} from './cloudDirectMessages';
import {
  parseCloudGroupControl,
  type CloudGroupReadCursor,
} from './cloudGroupMessages';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import { createCloudSelfAgentSessionPlanner } from './cloudSelfAgentSessionPlan';

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function cloudSelfAgentCanonicalMessageId(messageId: string): string {
  return `msg:cloud:self:${messageId}`;
}

function cloudSelfAgentCreatedAtMs(message: CloudMessage): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

type CloudSelfAgentRestoreMessage = {
  message: CloudMessage;
  sessionId: string;
  role: 'user' | 'agent';
  text: string;
  createdAtMs: number;
  responseRequestId: string | null;
  messageAction: MessageActionMetadata | null;
};

export function isSharedCloudSessionId(sessionId: string): boolean {
  const trimmed = cleanText(sessionId);
  return trimmed.startsWith('session:direct-person:')
    || trimmed.startsWith('session:group:');
}

export function cloudGroupReadCursorsBySessionId(
  canonicalState?: CanonicalSessionState | null,
): Record<string, CloudGroupReadCursor> {
  if (!canonicalState) return {};
  const rawMessageById = new Map(
    canonicalState.messages.map((message) => [message.id, message]),
  );
  const cursors: Record<string, CloudGroupReadCursor> = {};
  for (const participant of canonicalState.participants) {
    if (participant.role !== 'self') continue;
    if (
      canonicalState.profile.humanIdentityId
      && participant.identityId
        !== canonicalState.profile.humanIdentityId
    ) continue;
    const lastReadMessageId = cleanText(participant.lastReadMessageId);
    if (!lastReadMessageId) continue;
    const lastReadMessage = rawMessageById.get(lastReadMessageId);
    cursors[participant.sessionId] = {
      lastReadMessageId,
      lastReadCreatedAtMs:
        lastReadMessage?.createdAtMs
        ?? participant.lastSeenAtMs
        ?? null,
    };
  }
  return cursors;
}

function normalizeCloudSelfAgentRestoreMessage(
  message: CloudMessage,
  isGroupControl?: boolean,
): CloudSelfAgentRestoreMessage | null {
  const sessionId = cleanText(message.sessionId);
  if (!sessionId || isSharedCloudSessionId(sessionId)) return null;
  const response = parseCloudAgentResponse(message.body);
  if (
    !response
    && (
      parseCloudAgentCancel(message.body)
      || (
        isGroupControl
        ?? Boolean(parseCloudGroupControl(message.body))
      )
    )
  ) return null;
  const text = cleanText(
    response?.text ?? cloudDirectMessageDisplayText(message.body),
  );
  if (!text) return null;
  return {
    message,
    sessionId,
    role: response ? 'agent' : 'user',
    text,
    createdAtMs: cloudSelfAgentCreatedAtMs(message),
    responseRequestId: response?.requestId ?? null,
    messageAction: response ? null : cloudDirectMessageAction(message.body),
  };
}

function restoredForkSnapshotCloudMessageIds(
  messages: CloudSelfAgentRestoreMessage[],
  forksBySessionId: Record<string, CloudSessionForkSummary>,
): Set<string> {
  const messagesBySessionId =
    new Map<string, CloudSelfAgentRestoreMessage[]>();
  for (const message of messages) {
    const bucket = messagesBySessionId.get(message.sessionId) ?? [];
    bucket.push(message);
    messagesBySessionId.set(message.sessionId, bucket);
  }

  const snapshotIds = new Set<string>();
  for (const fork of Object.values(forksBySessionId)) {
    const forkSessionId = cleanText(fork.forkSessionId);
    const parentSessionId = cleanText(fork.parentSessionId);
    if (!forkSessionId || !parentSessionId) continue;
    const forkMessages = messagesBySessionId.get(forkSessionId) ?? [];
    const parentMessages =
      messagesBySessionId.get(parentSessionId) ?? [];
    if (forkMessages.length === 0 || parentMessages.length === 0) {
      continue;
    }

    for (
      let index = 0;
      index < forkMessages.length && index < parentMessages.length;
      index += 1
    ) {
      const forkMessage = forkMessages[index];
      const parentMessage = parentMessages[index];
      if (
        forkMessage.role !== parentMessage.role
        || forkMessage.text !== parentMessage.text
      ) break;
      snapshotIds.add(forkMessage.message.messageId);
    }
  }
  return snapshotIds;
}

function existingCanonicalMessageMatchesCloudSelfAgent(
  existing: CanonicalSessionMessage,
  input: {
    sessionId: string;
    role: 'user' | 'agent';
    text: string;
    createdAtMs: number;
    cloudMessageId: string;
  },
): boolean {
  if (existing.sessionId !== input.sessionId) return false;
  if (
    existing.id
    === cloudSelfAgentCanonicalMessageId(input.cloudMessageId)
  ) return true;
  if (
    existing.sourceTransport === 'cloud-self-agent'
    && existing.sourceEventId === input.cloudMessageId
  ) return true;
  const existingText = cleanText(existing.contentText);
  if (!existingText || existingText !== input.text) return false;
  const roleMatches = input.role === 'user'
    ? existing.senderRole === 'user'
    : existing.senderRole.includes('agent')
      || existing.messageKind === 'agent-turn';
  if (!roleMatches) return false;
  return Math.abs(existing.createdAtMs - input.createdAtMs) <= 5_000;
}

export function planCloudSelfAgentCanonicalSync({
  account,
  messages,
  state,
  forksBySessionId = {},
  groupRowByWireMessageId,
  cloudTitlesBySessionId = {},
}: {
  account: CloudAccount;
  messages: CloudMessage[];
  state: CanonicalSessionState;
  forksBySessionId?: Record<string, CloudSessionForkSummary>;
  groupRowByWireMessageId?: ReadonlyMap<string, IndexedCloudGroupRow>;
  cloudTitlesBySessionId?: Readonly<
    Record<string, CloudSessionTitle>
  >;
}): {
  agentIdentityRequest: UpsertCanonicalIdentityRequest;
  sessionRequests: OpenCanonicalSessionRequest[];
  messageRequests: AppendCanonicalMessageRequest[];
} {
  const localHumanIdentityId =
    state.profile.humanIdentityId?.trim()
    || `human:${account.accountId}`;
  const agentIdentityId = `agent:cloud-self:${account.accountId}`;
  const sorted = [...messages]
    .filter((message) => (
      message.fromAccountId === account.accountId
      && message.toAccountId === account.accountId
    ))
    .sort((left, right) => (
      cloudSelfAgentCreatedAtMs(left)
      - cloudSelfAgentCreatedAtMs(right)
      || left.messageId.localeCompare(right.messageId)
    ));
  const normalizedMessages = sorted
    .map((message) => normalizeCloudSelfAgentRestoreMessage(
      message,
      groupRowByWireMessageId?.has(message.messageId),
    ))
    .filter((
      message,
    ): message is CloudSelfAgentRestoreMessage => Boolean(message));
  const forkSnapshotCloudMessageIds =
    restoredForkSnapshotCloudMessageIds(
      normalizedMessages,
      forksBySessionId,
    );

  const userTextByCloudMessageId = new Map<string, string>();
  const requestLocalMessageIdByCloudMessageId =
    new Map<string, string>();
  const plannedCanonicalMessageIdByDuplicateKey =
    new Map<string, string>();
  const sessionPlanner = createCloudSelfAgentSessionPlanner({
    state,
    forksBySessionId,
    cloudTitlesBySessionId,
    localHumanIdentityId,
    agentIdentityId,
  });
  const messageRequests: AppendCanonicalMessageRequest[] = [];

  for (const restoreMessage of normalizedMessages) {
    const {
      message,
      sessionId,
      role,
      text,
      createdAtMs,
      responseRequestId,
      messageAction,
    } = restoreMessage;
    const sourceTransport =
      forkSnapshotCloudMessageIds.has(message.messageId)
        ? 'canonical-fork-snapshot'
        : 'cloud-self-agent';
    const existingMatch = state.messages.find((existing) =>
      existingCanonicalMessageMatchesCloudSelfAgent(existing, {
        sessionId,
        role,
        text,
        createdAtMs,
        cloudMessageId: message.messageId,
      })
    );
    if (existingMatch) {
      if (!responseRequestId) {
        userTextByCloudMessageId.set(message.messageId, text);
        requestLocalMessageIdByCloudMessageId.set(
          message.messageId,
          existingMatch.id,
        );
        sessionPlanner.ensure(
          sessionId,
          sourceTransport === 'canonical-fork-snapshot' ? '' : text,
          message.messageId,
          createdAtMs,
          sourceTransport === 'canonical-fork-snapshot',
        );
      } else {
        sessionPlanner.ensure(
          sessionId,
          sourceTransport === 'canonical-fork-snapshot'
            ? ''
            : cleanText(
                userTextByCloudMessageId.get(responseRequestId),
              ) || '',
          responseRequestId,
          createdAtMs,
          sourceTransport === 'canonical-fork-snapshot',
        );
      }
      if (
        sourceTransport === 'canonical-fork-snapshot'
        && existingMatch.sourceTransport !== sourceTransport
      ) {
        messageRequests.push({
          id: existingMatch.id,
          sessionId,
          senderIdentityId: existingMatch.senderIdentityId,
          senderRole: existingMatch.senderRole,
          messageKind: existingMatch.messageKind,
          contentText: existingMatch.contentText,
          content: existingMatch.content ?? null,
          parentMessageId: existingMatch.parentMessageId ?? null,
          status: existingMatch.status,
          createdAtMs: existingMatch.createdAtMs,
          sourceTransport,
          sourceEventId:
            existingMatch.sourceEventId ?? message.messageId,
        });
      }
      continue;
    }

    const duplicateKey = [
      sessionId,
      role,
      createdAtMs.toString(),
      text,
    ].join('\u001f');
    const plannedDuplicateMessageId =
      plannedCanonicalMessageIdByDuplicateKey.get(duplicateKey);
    if (plannedDuplicateMessageId) {
      if (!responseRequestId) {
        userTextByCloudMessageId.set(message.messageId, text);
        requestLocalMessageIdByCloudMessageId.set(
          message.messageId,
          plannedDuplicateMessageId,
        );
      }
      continue;
    }

    const canonicalMessageId =
      cloudSelfAgentCanonicalMessageId(message.messageId);
    if (!responseRequestId) {
      userTextByCloudMessageId.set(message.messageId, text);
      requestLocalMessageIdByCloudMessageId.set(
        message.messageId,
        canonicalMessageId,
      );
    }
    const quoteSourceMessageId = messageAction?.kind === 'quote'
      ? cleanText(messageAction.source.sourceMessageId)
      : null;
    const parentMessageId = responseRequestId
      ? requestLocalMessageIdByCloudMessageId.get(responseRequestId)
        ?? null
      : quoteSourceMessageId;
    const title = cleanText(
      userTextByCloudMessageId.get(
        responseRequestId ?? message.messageId,
      ),
    )
      || cleanText(sessionPlanner.existingById.get(sessionId)?.title)
      || '';
    sessionPlanner.ensure(
      sessionId,
      sourceTransport === 'canonical-fork-snapshot' ? '' : title,
      responseRequestId ?? message.messageId,
      createdAtMs,
      sourceTransport === 'canonical-fork-snapshot',
    );
    plannedCanonicalMessageIdByDuplicateKey.set(
      duplicateKey,
      canonicalMessageId,
    );
    messageRequests.push({
      id: canonicalMessageId,
      sessionId,
      senderIdentityId:
        responseRequestId ? agentIdentityId : localHumanIdentityId,
      senderRole: responseRequestId ? 'owned-agent' : 'user',
      messageKind: responseRequestId ? 'agent-turn' : 'text',
      contentText: text,
      content: responseRequestId
        ? { cloudRequestMessageId: responseRequestId }
        : messageAction
          ? {
              messageAction,
              ...(quoteSourceMessageId
                ? { replyToMessageId: quoteSourceMessageId }
                : {}),
            }
          : null,
      parentMessageId,
      status: responseRequestId ? 'complete' : 'sent',
      createdAtMs,
      sourceTransport,
      sourceEventId: message.messageId,
    });
  }

  return {
    agentIdentityRequest: {
      id: agentIdentityId,
      kind: 'agent',
      displayName: 'My Kordi',
      ownerIdentityId: localHumanIdentityId,
      source: 'local',
      sourceHostId: null,
      sourceIdentityId: null,
      humanId: null,
      agentId: `cloud-self:${account.accountId}`,
      avatarKey: `cloud-self:${account.accountId}`,
      profileImageUrl: null,
      metadata: {
        cloudSelfAgent: true,
        accountId: account.accountId,
      },
    },
    sessionRequests: sessionPlanner.requests,
    messageRequests,
  };
}

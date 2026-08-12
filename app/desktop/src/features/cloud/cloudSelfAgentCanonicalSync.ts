import type {
  AppendCanonicalMessageRequest,
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
import { parseCloudAgentCancel, parseCloudAgentResponse } from './cloudAgentMessages';
import { cloudDirectMessageAction, cloudDirectMessageDisplayText } from './cloudDirectMessages';
import { parseCloudGroupControl, type CloudGroupReadCursor } from './cloudGroupMessages';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import { createCloudSelfAgentSessionPlanner } from './cloudSelfAgentSessionPlan';
import {
  cloudSelfAgentStableResponseId,
  cloudSelfAgentResponseWouldDowngrade,
  createCloudSelfAgentCanonicalMessageIndex,
  legacyCloudSelfAgentResponseIds,
  shouldReplacePlannedCloudSelfAgentResponse,
  type CloudSelfAgentResponseDeliveryState,
} from './cloudSelfAgentResponseLifecycle';
import {
  indexLocalSelfAgentMessagesByClientMessageId,
  resolveCloudSelfAgentMirror,
  type CloudSelfAgentMirrorReconciliation,
} from './cloudSelfAgentMirrorPlan';

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

function cloudSelfAgentRestoreDependencyRank(message: CloudMessage) {
  return parseCloudAgentResponse(message.body) ? 1 : 0;
}

type CloudSelfAgentRestoreMessage = {
  message: CloudMessage;
  sessionId: string;
  role: 'user' | 'agent';
  text: string;
  createdAtMs: number;
  responseRequestId: string | null;
  responseDeliveryState: CloudSelfAgentResponseDeliveryState | null;
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
    responseDeliveryState: response
      ? response.deliveryState ?? 'complete'
      : null,
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

export type CloudSelfAgentCanonicalSyncPlan = {
  agentIdentityRequest: UpsertCanonicalIdentityRequest;
  sessionRequests: OpenCanonicalSessionRequest[];
  messageRequests: AppendCanonicalMessageRequest[];
  mirrorReconciliations: CloudSelfAgentMirrorReconciliation[];
};

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
}): CloudSelfAgentCanonicalSyncPlan {
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
      || cloudSelfAgentRestoreDependencyRank(left)
      - cloudSelfAgentRestoreDependencyRank(right)
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
  const requestCloudIdentityByCloudMessageId = new Map<string, string>();
  const plannedCanonicalMessageIdByDuplicateKey =
    new Map<string, string>();
  const plannedMessageIndexByCanonicalId = new Map<string, number>();
  const mirrorReconciliations: CloudSelfAgentCanonicalSyncPlan['mirrorReconciliations'] = [];
  const existingCanonicalMessageIndex =
    createCloudSelfAgentCanonicalMessageIndex(state.messages);
  const localUserMessageByClientMessageId =
    indexLocalSelfAgentMessagesByClientMessageId(state.messages);
  const legacyResponseIdByStableCanonicalId =
    legacyCloudSelfAgentResponseIds({
      canonicalMessages: state.messages,
      responses: normalizedMessages.flatMap((normalized) => (
        normalized.responseRequestId
          ? [{
              sessionId: normalized.sessionId,
              requestCloudMessageId: normalized.responseRequestId,
              responseCloudMessageId: normalized.message.messageId,
            }]
          : []
      )),
    });
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
      responseDeliveryState,
      messageAction,
    } = restoreMessage;
    const sourceTransport =
      forkSnapshotCloudMessageIds.has(message.messageId)
        ? 'canonical-fork-snapshot'
        : 'cloud-self-agent';
    const stableRequestCloudMessageId = responseRequestId
      ? requestCloudIdentityByCloudMessageId.get(responseRequestId)
        ?? responseRequestId
      : message.messageId;
    const derivedStableCanonicalMessageId = responseRequestId
      ? cloudSelfAgentStableResponseId(stableRequestCloudMessageId)
      : cloudSelfAgentCanonicalMessageId(message.messageId);
    const stableCanonicalMessageId = cleanText(
      message.canonicalHistoryLocalMessageId,
    ) || (
      legacyResponseIdByStableCanonicalId.get(
        derivedStableCanonicalMessageId,
      ) ?? derivedStableCanonicalMessageId
    );
    const { existingMatch, reconciliation } = resolveCloudSelfAgentMirror({
      message,
      sessionId,
      role,
      text,
      createdAtMs,
      stableCanonicalMessageId,
      existingCanonicalMessageIndex,
      localUserMessageByClientMessageId,
    });
    if (reconciliation) mirrorReconciliations.push(reconciliation);
    if (existingMatch && !responseRequestId) {
      userTextByCloudMessageId.set(message.messageId, text);
      requestLocalMessageIdByCloudMessageId.set(
        message.messageId,
        existingMatch.id,
      );
      requestCloudIdentityByCloudMessageId.set(
        message.messageId,
        existingMatch.sourceTransport === 'cloud-self-agent'
          ? cleanText(existingMatch.sourceEventId) || message.messageId
          : message.messageId,
      );
      sessionPlanner.ensure(
        sessionId,
        sourceTransport === 'canonical-fork-snapshot' ? '' : text,
        message.messageId,
        createdAtMs,
        sourceTransport === 'canonical-fork-snapshot',
      );
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
        const duplicateCloudIdentity = [...requestLocalMessageIdByCloudMessageId]
          .find(([, canonicalId]) => (
            canonicalId === plannedDuplicateMessageId
          ))?.[0] ?? message.messageId;
        requestCloudIdentityByCloudMessageId.set(
          message.messageId,
          requestCloudIdentityByCloudMessageId.get(duplicateCloudIdentity)
            ?? duplicateCloudIdentity,
        );
      }
      continue;
    }

    const canonicalMessageId = existingMatch?.id ?? stableCanonicalMessageId;
    if (!responseRequestId) {
      userTextByCloudMessageId.set(message.messageId, text);
      requestLocalMessageIdByCloudMessageId.set(
        message.messageId,
        canonicalMessageId,
      );
      requestCloudIdentityByCloudMessageId.set(
        message.messageId,
        message.messageId,
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
    const deliveryState = responseRequestId
      ? responseDeliveryState ?? 'complete'
      : null;
    if (
      existingMatch
      && cloudSelfAgentResponseWouldDowngrade(
        existingMatch.status,
        deliveryState,
      )
    ) {
      continue;
    }
    const request: AppendCanonicalMessageRequest = {
      id: canonicalMessageId,
      sessionId,
      senderIdentityId:
        responseRequestId ? agentIdentityId : localHumanIdentityId,
      senderRole: responseRequestId ? 'owned-agent' : 'user',
      messageKind: responseRequestId ? 'agent-turn' : 'text',
      contentText: deliveryState === 'failed' ? '' : text,
      content: responseRequestId
        ? {
            cloudRequestMessageId: stableRequestCloudMessageId,
            requestId: parentMessageId ?? stableRequestCloudMessageId,
            replyToMessageId: parentMessageId ?? stableRequestCloudMessageId,
            deliveryState,
            ...(deliveryState === 'failed' ? { error: text } : {}),
          }
        : messageAction
          ? {
              messageAction,
              ...(quoteSourceMessageId
                ? { replyToMessageId: quoteSourceMessageId }
                : {}),
            }
          : null,
      parentMessageId,
      status: responseRequestId ? deliveryState ?? 'complete' : 'sent',
      createdAtMs,
      sourceTransport,
      sourceEventId: message.messageId,
    };
    const plannedIndex = plannedMessageIndexByCanonicalId.get(
      canonicalMessageId,
    );
    if (plannedIndex === undefined) {
      plannedMessageIndexByCanonicalId.set(
        canonicalMessageId,
        messageRequests.length,
      );
      messageRequests.push(request);
    } else {
      const planned = messageRequests[plannedIndex];
      if (
        deliveryState
        && shouldReplacePlannedCloudSelfAgentResponse(
          planned.status,
          deliveryState,
        )
      ) {
        messageRequests[plannedIndex] = request;
      }
    }
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
    mirrorReconciliations,
  };
}

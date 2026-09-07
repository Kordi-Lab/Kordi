import type {
  AppendCanonicalMessageRequest,
  CanonicalSessionState,
  OpenCanonicalSessionRequest,
  UpsertCanonicalIdentityRequest,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudMessage,
  CloudSessionForkSummary,
  CloudSessionTitle,
} from './authClient';
import { cloudAgentExecutionCanonicalContent } from './cloudAgentExecutionTrace';
import { defaultCloudAgentId } from './cloudAgentIdentity';
import { canonicalAvatarImageSource } from './canonicalAvatar';
import { type CloudGroupReadCursor } from './cloudGroupMessages';
import type { IndexedCloudGroupRow } from './cloudMessageIndex';
import { createCloudSelfAgentSessionPlanner } from './cloudSelfAgentSessionPlan';
import {
  cloudSelfAgentStableResponseId,
  cloudSelfAgentResponseWouldDowngrade,
  createCloudSelfAgentCanonicalMessageIndex,
  legacyCloudSelfAgentResponseIds,
  shouldReplacePlannedCloudSelfAgentResponse,
} from './cloudSelfAgentResponseLifecycle';
import {
  indexLocalSelfAgentMessagesByClientMessageId,
  resolveCloudSelfAgentMirror,
  type CloudSelfAgentMirrorReconciliation,
} from './cloudSelfAgentMirrorPlan';
import {
  cloudSelfAgentCreatedAtMs,
  cloudSelfAgentRestoreDependencyRank,
  normalizeCloudSelfAgentRestoreMessage,
  type CloudSelfAgentRestoreMessage,
} from './cloudSelfAgentRestoreMessage';
import { restoredForkSnapshotCloudMessageIds } from './cloudSelfAgentCanonicalIndexes';

export { isSharedCloudSessionId } from './cloudSelfAgentRestoreMessage';
export { cloudGroupReadCursorsBySessionId } from './cloudSelfAgentCanonicalIndexes';

function cleanText(value?: string | null) {
  return (value ?? '').trim();
}

function cloudSelfAgentCanonicalMessageId(messageId: string): string {
  return `msg:cloud:self:${messageId}`;
}

export type CloudSelfAgentCanonicalSyncPlan = {
  agentIdentityRequest: UpsertCanonicalIdentityRequest;
  sessionRequests: OpenCanonicalSessionRequest[];
  messageRequests: AppendCanonicalMessageRequest[];
  mirrorReconciliations: CloudSelfAgentMirrorReconciliation[];
};

export function planCloudSelfAgentCanonicalSync({
  account,
  agentDisplayName,
  messages,
  state,
  forksBySessionId = {},
  groupRowByWireMessageId,
  cloudTitlesBySessionId = {},
  durableSourceEventIds,
}: {
  account: CloudAccount;
  agentDisplayName?: string | null;
  messages: CloudMessage[];
  state: CanonicalSessionState;
  forksBySessionId?: Record<string, CloudSessionForkSummary>;
  groupRowByWireMessageId?: ReadonlyMap<string, IndexedCloudGroupRow>;
  cloudTitlesBySessionId?: Readonly<
    Record<string, CloudSessionTitle>
  >;
  durableSourceEventIds?: ReadonlySet<string>;
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
  const durableTerminalRequestIds = new Set(
    normalizedMessages.flatMap((message) => (
      durableSourceEventIds?.has(message.message.messageId)
      && message.responseRequestId
      && !['sending', 'queued', 'processing'].includes(
        message.responseDeliveryState ?? 'complete',
      )
        ? [message.responseRequestId]
        : []
    )),
  );
  const forkSnapshotCloudMessageIds =
    restoredForkSnapshotCloudMessageIds(
      normalizedMessages,
      forksBySessionId,
    );

  const userTextByCloudMessageId = new Map<string, string>();
  const requestCreatedAtMsByCloudMessageId = new Map<string, number>();
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
      messageKind,
      text,
      createdAtMs,
      responseRequestId,
      responseDeliveryState,
      responseExecution,
      messageAction, mentions, agentRuntimeRoute,
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
    const stableCanonicalMessageId = responseRequestId
      ? legacyResponseIdByStableCanonicalId.get(
          derivedStableCanonicalMessageId,
        ) ?? derivedStableCanonicalMessageId
      : cleanText(message.canonicalHistoryLocalMessageId)
        || derivedStableCanonicalMessageId;
    if (durableSourceEventIds?.has(message.messageId)) {
      if (!responseRequestId && role === 'user') {
        userTextByCloudMessageId.set(message.messageId, text);
        requestCreatedAtMsByCloudMessageId.set(
          message.messageId,
          createdAtMs,
        );
        requestLocalMessageIdByCloudMessageId.set(
          message.messageId,
          stableCanonicalMessageId,
        );
        requestCloudIdentityByCloudMessageId.set(
          message.messageId,
          message.messageId,
        );
      }
      continue;
    }
    if (
      responseRequestId
      && durableTerminalRequestIds.has(responseRequestId)
    ) continue;
    const existingStableResponse = responseRequestId
      ? existingCanonicalMessageIndex.byId.get(stableCanonicalMessageId)
      : null;
    const existingParentRequest = existingStableResponse?.parentMessageId
      ? existingCanonicalMessageIndex.byId.get(
          existingStableResponse.parentMessageId,
        )
      : null;
    const responseAnchorCreatedAtMs = responseRequestId
      ? requestCreatedAtMsByCloudMessageId.get(responseRequestId)
        ?? existingParentRequest?.createdAtMs
        ?? null
      : null;
    const displayCreatedAtMs = responseAnchorCreatedAtMs === null
      ? createdAtMs
      : responseAnchorCreatedAtMs + 1;
    const { existingMatch, reconciliation } = resolveCloudSelfAgentMirror({
      message,
      sessionId,
      role,
      text,
      createdAtMs: displayCreatedAtMs,
      stableCanonicalMessageId,
      existingCanonicalMessageIndex,
      localUserMessageByClientMessageId,
    });
    if (reconciliation) mirrorReconciliations.push(reconciliation);
    if (existingMatch && !responseRequestId) {
      const isUserRequest = role === 'user';
      if (isUserRequest) {
        userTextByCloudMessageId.set(message.messageId, text);
        requestCreatedAtMsByCloudMessageId.set(
          message.messageId,
          existingMatch.createdAtMs,
        );
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
      }
      sessionPlanner.ensure(
        sessionId,
        sourceTransport === 'canonical-fork-snapshot' || !isUserRequest
          ? ''
          : text,
        message.messageId,
        displayCreatedAtMs,
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
      if (!responseRequestId && role === 'user') {
        userTextByCloudMessageId.set(message.messageId, text);
        const duplicateCloudIdentity = [...requestLocalMessageIdByCloudMessageId]
          .find(([, canonicalId]) => (
            canonicalId === plannedDuplicateMessageId
          ))?.[0] ?? message.messageId;
        requestCreatedAtMsByCloudMessageId.set(
          message.messageId,
          requestCreatedAtMsByCloudMessageId.get(duplicateCloudIdentity)
            ?? createdAtMs,
        );
        requestLocalMessageIdByCloudMessageId.set(
          message.messageId,
          plannedDuplicateMessageId,
        );
        requestCloudIdentityByCloudMessageId.set(
          message.messageId,
          requestCloudIdentityByCloudMessageId.get(duplicateCloudIdentity)
            ?? duplicateCloudIdentity,
        );
      }
      continue;
    }

    const canonicalMessageId = existingMatch?.id ?? stableCanonicalMessageId;
    if (!responseRequestId && role === 'user') {
      userTextByCloudMessageId.set(message.messageId, text);
      requestCreatedAtMsByCloudMessageId.set(
        message.messageId,
        existingMatch?.createdAtMs ?? createdAtMs,
      );
      requestLocalMessageIdByCloudMessageId.set(
        message.messageId,
        canonicalMessageId,
      );
      requestCloudIdentityByCloudMessageId.set(
        message.messageId,
        message.messageId,
      );
    }
    const quoteSourceMessageId = messageAction?.kind === 'quote' || messageAction?.kind === 'thread'
      ? cleanText(messageAction.source.sourceMessageId)
      : null;
    const parentMessageId = responseRequestId
      ? requestLocalMessageIdByCloudMessageId.get(responseRequestId)
        ?? null
      : quoteSourceMessageId;
    const title = (role === 'system'
      ? ''
      : cleanText(
          userTextByCloudMessageId.get(
            responseRequestId ?? message.messageId,
          ),
        ))
      || cleanText(sessionPlanner.existingById.get(sessionId)?.title)
      || '';
    sessionPlanner.ensure(
      sessionId,
      sourceTransport === 'canonical-fork-snapshot' ? '' : title,
      responseRequestId ?? message.messageId,
      displayCreatedAtMs,
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
        existingMatch.contentText,
        text,
      )
    ) {
      continue;
    }
    const request: AppendCanonicalMessageRequest = {
      id: canonicalMessageId,
      sessionId,
      senderIdentityId:
        responseRequestId || role === 'system'
          ? sessionPlanner.agentIdentityIdForSession(sessionId)
          : localHumanIdentityId,
      senderRole: responseRequestId
        ? 'owned-agent'
        : role === 'system'
          ? 'system'
          : 'user',
      messageKind,
      contentText: deliveryState === 'failed' ? '' : text,
      content: responseRequestId
        ? {
            cloudRequestMessageId: stableRequestCloudMessageId,
            requestId: parentMessageId ?? stableRequestCloudMessageId,
            replyToMessageId: parentMessageId ?? stableRequestCloudMessageId,
            deliveryState,
            ...cloudAgentExecutionCanonicalContent(responseExecution),
            ...(deliveryState === 'failed' ? { error: text } : {}),
          }
        : role === 'system' && agentRuntimeRoute
          ? { agentRuntimeRoute }
          : messageAction || mentions?.length
          ? {
              ...(messageAction ? { messageAction } : {}),
              ...(mentions?.length ? { mentions } : {}),
              ...(quoteSourceMessageId
                ? { replyToMessageId: quoteSourceMessageId }
                : {}),
            }
          : null,
      parentMessageId,
      status: responseRequestId ? deliveryState ?? 'complete' : 'sent',
      createdAtMs: displayCreatedAtMs,
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
          planned.contentText,
          text,
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
      displayName: cleanText(agentDisplayName) || 'Kordi',
      ownerIdentityId: localHumanIdentityId,
      source: 'local',
      sourceHostId: null,
      sourceIdentityId: null,
      humanId: null,
      agentId: defaultCloudAgentId(account.accountId),
      avatarKey: defaultCloudAgentId(account.accountId),
      profileImageUrl: account.defaultAgent ? canonicalAvatarImageSource(account.defaultAgent.avatar) : null,
      metadata: {
        cloudSelfAgent: true,
        accountId: account.accountId,
      },
    },
    sessionRequests: sessionPlanner.requests,
    messageRequests: (() => {
      const reconciledDuplicateIds = new Set(
        mirrorReconciliations.map((item) => item.duplicateMessageId),
      );
      return messageRequests.filter((request) => (
        !request.id || !reconciledDuplicateIds.has(request.id)
      ));
    })(),
    mirrorReconciliations,
  };
}

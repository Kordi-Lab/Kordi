import {
  upsertCanonicalIdentityFast,
  upsertCanonicalMessageFast,
} from '@/lib/desktop';
import type {
  AppendCanonicalMessageRequest,
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionState,
} from '@/kordi-app/types';
import { mergeCanonicalMessageRow } from '@/features/canonical/canonicalStateReducers';
import { cloudMessageAttachmentToMessageAttachment } from './cloudAttachments';
import { cloudGroupAgentConversationId } from './cloudGroupMessages';
import { cloudGroupCanonicalMessageSource } from './cloudMessageIndex';
import type {
  CanonicalSessionStateSetter,
  CloudGroupControlContext,
  CloudGroupMessageControlContext,
} from './cloudGroupControlContext';

type CloudGroupMessageStateOps = {
  objectContent(value: unknown): Record<string, unknown>;
  cleanText(value?: string | null): string;
  upsertIdentity(
    current: CanonicalSessionState | null,
    identity: CanonicalIdentity,
  ): CanonicalSessionState | null;
  processingSlot(
    messages: CanonicalSessionMessage[],
    groupId: string,
    requestId: string,
    senderAccountId: string,
  ): CanonicalSessionMessage | null;
  incomingAlreadyApplied(
    existingMessage: CanonicalSessionMessage | null,
    incomingDeliveryState?: string | null,
    incomingMessageKind?: string | null,
  ): boolean;
  removeOfflinePlaceholder(
    current: CanonicalSessionState | null,
    noticeId: string,
  ): CanonicalSessionState | null;
  removeTimeoutPlaceholder(
    current: CanonicalSessionState | null,
    noticeId: string,
  ): CanonicalSessionState | null;
  removePendingRows(
    current: CanonicalSessionState | null,
    requestId: string,
    targetAccountId: string,
  ): CanonicalSessionState | null;
  removeMessage(
    current: CanonicalSessionState | null,
    messageId: string,
  ): CanonicalSessionState | null;
  isProcessingPlaceholder(text: string): boolean;
};

export type ApplyCloudGroupMessageControlInput = {
  context: CloudGroupControlContext;
  setCanonicalState: CanonicalSessionStateSetter;
  stateOps: CloudGroupMessageStateOps;
};

function isPendingAgentDeliveryState(
  state: string | null,
): state is 'queued' | 'processing' {
  return state === 'queued' || state === 'processing';
}

export async function applyCloudGroupMessageControl({
  context,
  setCanonicalState,
  stateOps,
}: ApplyCloudGroupMessageControlInput): Promise<CloudGroupMessageControlContext | null> {
  const {
    account,
    cloudMessage,
    envelope,
    canonicalState,
    participantByAccount,
    identityIdByAccount,
  } = context;
  let nextState = context.nextState;
  const message = envelope.message;
  if (!message) {
    setCanonicalState(nextState);
    return null;
  }
  const senderHumanIdentityId = identityIdByAccount.get(message.senderAccountId);
  if (!senderHumanIdentityId) {
    setCanonicalState(nextState);
    return null;
  }

  // Match owner responses to the stable processing slot. A terminal replay
  // replaces that slot in place instead of adding a second row.
  const isOwnAgentResponseRoundTrip = message.senderKind === 'agent'
    && message.senderAccountId === account.accountId
    && Boolean((message.replyToMessageId || message.requestId)?.trim());
  const senderIsAgent = message.senderKind === 'agent';
  const senderIdentityId = senderIsAgent
    ? `agent:cloud:${message.senderAccountId}`
    : senderHumanIdentityId;
  const messageReplyToId = message.replyToMessageId?.trim()
    || message.requestId?.trim()
    || null;
  const agentDeliveryState = senderIsAgent
    ? (message.deliveryState?.trim()
      || (stateOps.isProcessingPlaceholder(message.text) ? 'processing' : 'complete'))
    : null;
  const humanOutgoingDeliveryState = !senderIsAgent
    && message.senderAccountId === account.accountId
    ? (cloudMessage.readAt ? 'read' : 'delivered')
    : null;
  const ownAgentProcessingId = isOwnAgentResponseRoundTrip
    ? `msg:cloud-agent-processing:${(message.replyToMessageId || message.requestId || '').trim()}:${account.accountId}`
    : null;
  const incomingSource = cloudGroupCanonicalMessageSource(cloudMessage, envelope);
  if (!incomingSource) {
    setCanonicalState(nextState);
    return null;
  }
  const {
    sourceTransport: incomingSourceTransport,
    sourceEventId: incomingSourceEventId,
  } = incomingSource;
  const existingCloudGroupMessages = [canonicalState, nextState].flatMap((state) => state.messages);
  const existingCloudGroupMessage = existingCloudGroupMessages.find((candidate) => (
    candidate.sourceTransport === incomingSourceTransport
      && candidate.sourceEventId === incomingSourceEventId
  )) ?? existingCloudGroupMessages.find((candidate) => (
    candidate.id === message.id
      || (ownAgentProcessingId !== null && candidate.id === ownAgentProcessingId)
  )) ?? null;
  const existingCloudGroupContent = stateOps.objectContent(existingCloudGroupMessage?.content);
  const existingCloudMessageVersion = typeof existingCloudGroupContent.cloudMessageVersion === 'number'
    ? existingCloudGroupContent.cloudMessageVersion
    : 0;
  const messageAlreadyExists = existingCloudGroupMessage?.sourceTransport === incomingSourceTransport
    && existingCloudGroupMessage.sourceEventId === incomingSourceEventId
    && existingCloudMessageVersion >= (cloudMessage.version ?? 1)
    && stateOps.incomingAlreadyApplied(
      existingCloudGroupMessage,
      agentDeliveryState ?? humanOutgoingDeliveryState,
      message.messageKind,
    );
  if (senderIsAgent) {
    const owner = participantByAccount.get(message.senderAccountId);
    const senderIdentity = await upsertCanonicalIdentityFast({
      id: senderIdentityId,
      kind: 'agent',
      displayName: message.senderDisplayName?.trim() || `${owner?.displayName || 'Cloud user'}'s Kordi`,
      ownerIdentityId: senderHumanIdentityId,
      source: 'cloud',
      sourceHostId: 'cloud',
      sourceIdentityId: `cloud-agent:${message.senderAccountId}`,
      humanId: message.senderAccountId,
      agentId: `cloud-agent:${message.senderAccountId}`,
      avatarKey: `cloud-agent:${message.senderAccountId}`,
      profileImageUrl: null,
      metadata: { accountId: message.senderAccountId, cloudGroupAgent: true },
    });
    nextState = stateOps.upsertIdentity(nextState, senderIdentity) ?? nextState;
  }
  const cloudAttachments = cloudMessage.attachments?.length
    ? cloudMessage.attachments
    : message.attachments ?? [];
  const mappedAttachments = cloudAttachments.map((attachment) => {
    const mapped = cloudMessageAttachmentToMessageAttachment(attachment);
    return message.messageKind === 'sticker' && mapped.kind === 'image'
      ? { ...mapped, subtype: 'sticker' as const }
      : mapped;
  });

  if (
    messageAlreadyExists
    && existingCloudGroupMessage
    && mappedAttachments.some((attachment) => attachment.localPath)
  ) {
    const content = stateOps.objectContent(existingCloudGroupMessage.content);
    const existingAttachments: unknown[] = Array.isArray(content.attachments)
      ? content.attachments
      : [];
    const shouldUpdateCachedAttachments = existingAttachments.some((attachment) => {
      const record = stateOps.objectContent(attachment);
      return typeof record.attachmentId === 'string'
        && !record.localPath
        && mappedAttachments.some((mapped) => (
          mapped.attachmentId === record.attachmentId && mapped.localPath
        ));
    });
    if (shouldUpdateCachedAttachments) {
      const mergedAttachments = existingAttachments.map((attachment: unknown) => {
        const record = stateOps.objectContent(attachment);
        const attachmentId = typeof record.attachmentId === 'string' ? record.attachmentId : null;
        const cached = attachmentId
          ? mappedAttachments.find((mapped) => (
              mapped.attachmentId === attachmentId && mapped.localPath
            ))
          : null;
        return cached ? { ...record, localPath: cached.localPath } : attachment;
      });
      const attachmentUpdateRequest = {
        id: existingCloudGroupMessage.id,
        sessionId: existingCloudGroupMessage.sessionId,
        senderIdentityId: existingCloudGroupMessage.senderIdentityId,
        senderRole: existingCloudGroupMessage.senderRole,
        messageKind: existingCloudGroupMessage.messageKind,
        contentText: existingCloudGroupMessage.contentText,
        content: { ...content, attachments: mergedAttachments },
        createdAtMs: existingCloudGroupMessage.createdAtMs,
        parentMessageId: existingCloudGroupMessage.parentMessageId ?? null,
        status: existingCloudGroupMessage.status,
        sourceTransport: existingCloudGroupMessage.sourceTransport,
        sourceEventId: existingCloudGroupMessage.sourceEventId,
      } satisfies AppendCanonicalMessageRequest;
      const persistedMessage = await upsertCanonicalMessageFast(attachmentUpdateRequest);
      nextState = mergeCanonicalMessageRow(nextState, persistedMessage) ?? nextState;
      setCanonicalState(nextState);
    }
  }

  const responseProcessingSlot = senderIsAgent
    && messageReplyToId
    && !isPendingAgentDeliveryState(agentDeliveryState)
    ? [canonicalState, nextState]
        .map((state) => stateOps.processingSlot(
          state.messages,
          envelope.groupId,
          messageReplyToId,
          message.senderAccountId,
        ))
        .find((candidate): candidate is CanonicalSessionMessage => Boolean(candidate)) ?? null
    : null;
  if (
    messageAlreadyExists
    && responseProcessingSlot
    && responseProcessingSlot.id !== existingCloudGroupMessage?.id
  ) {
    nextState = stateOps.removeMessage(nextState, responseProcessingSlot.id) ?? nextState;
    setCanonicalState(nextState);
  }

  if (!messageAlreadyExists) {
    const stableAgentNoticeId = senderIsAgent && messageReplyToId
      ? `msg:cloud-agent-processing:${messageReplyToId}:${message.senderAccountId}`
      : null;
    const terminalStableAgentNoticeId = stableAgentNoticeId
      && !isPendingAgentDeliveryState(agentDeliveryState)
      ? stableAgentNoticeId
      : null;
    const existingStableRow = stableAgentNoticeId
      ? [canonicalState, nextState]
          .map((state) => state.messages.find((candidate) => candidate.id === stableAgentNoticeId) ?? null)
          .find((candidate): candidate is CanonicalSessionMessage => Boolean(candidate)) ?? null
      : null;
    const existingStableRowContent = existingStableRow
      ? stateOps.objectContent(existingStableRow.content)
      : null;
    const existingStableRowDeliveryState = stateOps.cleanText(
      typeof existingStableRowContent?.deliveryState === 'string'
        ? existingStableRowContent.deliveryState
        : null,
    ).toLowerCase();
    const existingStableRowStatus = (existingStableRow?.status || '').trim().toLowerCase();
    const existingStableRowTerminalLocked = existingStableRow
      ? ['cancelled', 'complete'].includes(existingStableRowStatus)
        || ['cancelled', 'complete'].includes(existingStableRowDeliveryState)
        || (
          existingStableRow.sourceTransport === 'cloud-group-agent'
          && existingStableRowDeliveryState === 'failed'
        )
      : false;
    if (
      existingStableRowTerminalLocked
      && isPendingAgentDeliveryState(agentDeliveryState)
    ) {
      setCanonicalState(nextState);
      return null;
    }
    const replacementAgentSlot = existingStableRow ?? responseProcessingSlot;
    const messageStatus = senderIsAgent && isPendingAgentDeliveryState(
      agentDeliveryState,
    )
      ? agentDeliveryState
      : senderIsAgent && agentDeliveryState === 'failed'
        ? 'failed'
        : senderIsAgent && agentDeliveryState === 'cancelled'
          ? 'cancelled'
          : humanOutgoingDeliveryState ?? 'received';
    const structuredContent = stateOps.objectContent(message.structuredContent);
    const messageRequest = {
      id: replacementAgentSlot?.id ?? terminalStableAgentNoticeId ?? message.id,
      sessionId: envelope.groupId,
      senderIdentityId,
      senderRole: senderIsAgent
        ? 'external-agent'
        : (message.senderAccountId === account.accountId ? 'user' : 'person'),
      messageKind: stateOps.cleanText(message.messageKind)
        || (senderIsAgent ? 'agent-turn' : 'text'),
      contentText: senderIsAgent && agentDeliveryState === 'failed' ? '' : message.text,
      content: senderIsAgent ? {
        ...structuredContent,
        cloudMessageVersion: cloudMessage.version ?? null,
        editedAt: cloudMessage.editedAt ?? null,
        ...(message.mentions?.length ? { mentions: message.mentions } : {}),
        sender: message.senderDisplayName?.trim() || 'Kordi',
        timestampMs: message.createdAtMs,
        deliveryState: agentDeliveryState,
        cloudGroupMessageId: message.id,
        sourceConversationId: cloudGroupAgentConversationId(envelope.groupId),
        requestId: messageReplyToId,
        replyToMessageId: messageReplyToId,
        ...(agentDeliveryState === 'failed' ? { error: message.text || 'Message failed' } : {}),
      } : (Object.keys(structuredContent).length > 0 || mappedAttachments.length > 0 || message.voiceMessage?.mediaId || message.mentions?.length || message.messageAction) ? {
        ...structuredContent,
        cloudMessageVersion: cloudMessage.version ?? null,
        editedAt: cloudMessage.editedAt ?? null,
        ...(mappedAttachments.length > 0 ? { attachments: mappedAttachments } : {}),
        ...(message.voiceMessage?.mediaId ? {
          voiceMessage: {
            ...message.voiceMessage,
            mediaId: message.voiceMessage.mediaId,
          },
        } : {}),
        ...(message.mentions?.length ? { mentions: message.mentions } : {}),
        ...(message.messageAction ? {
          messageAction: message.messageAction,
          replyToMessageId: message.messageAction.kind === 'quote'
            ? message.messageAction.source.sourceMessageId
            : undefined,
        } : {}),
      } : {
        cloudMessageVersion: cloudMessage.version ?? null,
        editedAt: cloudMessage.editedAt ?? null,
      },
      createdAtMs: message.createdAtMs,
      parentMessageId: senderIsAgent
        ? messageReplyToId
        : (message.messageAction?.kind === 'quote'
            ? message.messageAction.source.sourceMessageId
            : null),
      status: messageStatus,
      sourceTransport: incomingSourceTransport,
      sourceEventId: incomingSourceEventId,
    };
    const persistedMessage = await upsertCanonicalMessageFast(messageRequest);
    nextState = mergeCanonicalMessageRow(nextState, persistedMessage) ?? nextState;
    if (senderIsAgent && messageReplyToId) {
      const offlinePlaceholderId = `msg:cloud-agent-offline:${messageReplyToId}:${message.senderAccountId}`;
      nextState = isPendingAgentDeliveryState(agentDeliveryState)
        ? stateOps.removeOfflinePlaceholder(nextState, offlinePlaceholderId) ?? nextState
        : stateOps.removePendingRows(nextState, messageReplyToId, message.senderAccountId) ?? nextState;
    }
    setCanonicalState(nextState);
  }

  if (
    messageAlreadyExists
    && senderIsAgent
    && messageReplyToId
    && !isPendingAgentDeliveryState(agentDeliveryState)
  ) {
    const offlinePlaceholderId = `msg:cloud-agent-offline:${messageReplyToId}:${message.senderAccountId}`;
    const cleanedState = stateOps.removePendingRows(nextState, messageReplyToId, message.senderAccountId)
      ?? stateOps.removeTimeoutPlaceholder(nextState, offlinePlaceholderId)
      ?? nextState;
    if (cleanedState !== nextState) {
      nextState = cleanedState;
      setCanonicalState(nextState);
    }
  }
  return {
    ...context,
    nextState,
    senderIsAgent,
    mappedAttachments,
  };
}

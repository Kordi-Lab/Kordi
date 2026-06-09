import type {
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionState,
  DesktopChatToolSnapshot,
  Message,
  MessageActionMetadata,
  MessageAttachment,
  MessageMention,
} from '@/kordi-app/types';
import { isProcessingPlaceholderText, stripOutreachContextEnvelope } from '@/features/bridge/agentPlaceholderText';
import { cloudAgentFallbackErrorNotice, isCloudAgentNoProviderConfiguredError } from '@/features/cloud/cloudAgentMessages';
import { cloudGroupAgentConversationId } from '@/features/cloud/cloudGroupMessages';
import { isSelfReferenceName, possessiveScopedLabel, rewriteLeadingFirstPersonAgentMention, selfDisplayName } from '@/lib/identityLabels';
import { formatDesktopClockTime } from '@/lib/time';

// Re-exported so external importers that previously pulled these from
// messageMapping (none today, but the exports were public API) keep working.
export { isProcessingPlaceholderText, stripOutreachContextEnvelope };

export function contentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

export function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function canonicalMentions(value: unknown): MessageMention[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const mentions = value.flatMap((item) => {
    const record = contentRecord(item);
    const label = stringValue(record.label)?.trim();
    if (!label) return [];
    return [{
      label,
      targetKind: stringValue(record.targetKind) ?? undefined,
      bridgeHostId: stringValue(record.bridgeHostId) ?? null,
      nodeId: stringValue(record.nodeId) ?? null,
      humanId: stringValue(record.humanId) ?? null,
      agentId: stringValue(record.agentId) ?? null,
    }];
  });

  return mentions.length > 0 ? mentions : undefined;
}

export function canonicalAttachments(value: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const attachments = value.flatMap((item) => {
    const record = contentRecord(item);
    const name = stringValue(record.name);
    const rawKind = stringValue(record.kind);
    if (!name || (rawKind !== 'image' && rawKind !== 'file')) return [];

    const kind: MessageAttachment['kind'] = rawKind;
    const attachment: MessageAttachment = {
      kind,
      name,
      formatLabel: stringValue(record.formatLabel) ?? null,
      previewUrl: stringValue(record.previewUrl) ?? null,
      mimeType: stringValue(record.mimeType) ?? null,
      localPath: stringValue(record.localPath) ?? null,
      sizeBytes: numberValue(record.sizeBytes) ?? null,
    };
    const downloadUrl = stringValue(record.downloadUrl);
    const attachmentId = stringValue(record.attachmentId);
    if (downloadUrl) attachment.downloadUrl = downloadUrl;
    if (attachmentId) attachment.attachmentId = attachmentId;
    return [attachment];
  });

  return attachments.length > 0 ? attachments : undefined;
}

function canonicalMessageAction(value: unknown): MessageActionMetadata | null {
  const record = contentRecord(value);
  if (record.schemaVersion !== 1 || (record.kind !== 'quote' && record.kind !== 'forward')) return null;
  const source = contentRecord(record.source);
  const sourceSessionId = stringValue(source.sourceSessionId)?.trim();
  const sourceMessageId = stringValue(source.sourceMessageId)?.trim();
  const senderLabel = stringValue(source.senderLabel)?.trim();
  if (!sourceSessionId || !sourceMessageId || !senderLabel) return null;
  return {
    schemaVersion: 1,
    kind: record.kind,
    source: {
      sourceSessionId,
      sourceMessageId,
      sourceMessageKind: stringValue(source.sourceMessageKind) ?? null,
      senderLabel,
      textPreview: stringValue(source.textPreview)?.trim() ?? '',
      attachmentCount: Math.max(0, Math.floor(numberValue(source.attachmentCount) ?? 0)),
      createdAtMs: numberValue(source.createdAtMs) ?? null,
      timeLabel: stringValue(source.timeLabel) ?? null,
    },
  };
}

function realSourceLabelForRelativeLabel(label: string, humanSourceLabel: string, agentSourceLabel: string) {
  const trimmed = label.trim();
  const normalized = trimmed.toLowerCase();
  if ((normalized === 'me' || normalized === 'you') && humanSourceLabel.trim()) {
    return humanSourceLabel.trim();
  }
  if (normalized === 'my kordi' && agentSourceLabel.trim()) {
    return agentSourceLabel.trim();
  }
  return trimmed;
}

function canonicalMessageActionWithRealSourceLabel(
  action: MessageActionMetadata | null,
  humanSourceLabel: string,
  agentSourceLabel: string,
): MessageActionMetadata | null {
  if (!action) return null;
  const senderLabel = realSourceLabelForRelativeLabel(action.source.senderLabel, humanSourceLabel, agentSourceLabel);
  if (senderLabel === action.source.senderLabel) return action;
  return {
    ...action,
    source: {
      ...action.source,
      senderLabel,
    },
  };
}

function canonicalMessageActionSourceReference(action: MessageActionMetadata | null): Message['sourceMessage'] {
  if (!action || action.kind !== 'quote') return null;
  return {
    messageId: action.source.sourceMessageId,
    senderLabel: action.source.senderLabel,
    text: action.source.textPreview,
    attachmentCount: action.source.attachmentCount,
    time: action.source.timeLabel ?? null,
  };
}

function canonicalReadReceiptSummary(
  content: Record<string, unknown>,
  identityById: Map<string, CanonicalIdentity>,
): Message['readReceiptSummary'] {
  const summary = contentRecord(content.readReceiptSummary);
  const rawParticipants = Array.isArray(summary.participants) ? summary.participants : [];
  const participants = rawParticipants.flatMap((value) => {
    const record = contentRecord(value);
    const accountId = stringValue(record.accountId)?.trim() ?? '';
    const identityId = stringValue(record.identityId)?.trim() || (accountId ? `human:${accountId}` : '');
    if (!identityId) return [];
    const identity = identityById.get(identityId);
    const name = identity?.displayName || stringValue(record.name)?.trim() || accountId || 'Someone';
    return [{
      id: identity?.id ?? identityId,
      name,
      avatarSeed: identity?.avatarKey ?? stringValue(record.avatarSeed) ?? null,
      profileImageUrl: identity?.profileImageUrl ?? stringValue(record.profileImageUrl) ?? null,
      readAt: stringValue(record.readAt) ?? null,
    }];
  });
  const count = Math.max(0, Math.floor(numberValue(summary.count) ?? participants.length));
  if (count <= 0) return null;
  return { count, participants: participants.slice(0, Math.max(count, participants.length)) };
}

export function canonicalTools(value: unknown): DesktopChatToolSnapshot[] {
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
      artifactPath: stringValue(record.artifactPath) ?? null,
      toolLayer: stringValue(record.toolLayer) ?? null,
      isError: Boolean(record.isError),
    }];
  });
}

function safeToolArguments(rawArguments: string) {
  if (!rawArguments.trim()) return {};
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function contentTaskTarget(content: Record<string, unknown>) {
  const explicit = stringValue(content.taskTarget)?.trim();
  if (explicit) return explicit;
  const parentSessionKind = stringValue(content.parentSessionKind)?.trim().toLowerCase();
  const parentGroupSpaceId = stringValue(content.parentGroupSpaceId)?.trim();
  const parentSessionTitle = stringValue(content.parentSessionTitle)?.trim();
  if (parentSessionKind === 'group' || parentGroupSpaceId || parentSessionTitle?.startsWith('Group:')) {
    return `Group: ${parentSessionTitle || parentGroupSpaceId || 'Shared session'}`;
  }
  const targetDisplayName = stringValue(content.targetDisplayName)?.trim();
  const sender = stringValue(content.sender)?.trim();
  if (targetDisplayName) return `User: ${targetDisplayName}`;
  if (sender) return `User: ${sender}`;
  return null;
}

function toolHasTaskTarget(tool: DesktopChatToolSnapshot) {
  const args = safeToolArguments(tool.arguments);
  return Boolean(
    stringValue(args.taskTarget)
      || stringValue(args.task_target)
      || stringValue(args.targetAudience)
      || stringValue(args.target_audience)
      || stringValue(args.targetGroup)
      || stringValue(args.target_group)
      || stringValue(args.targetUser)
      || stringValue(args.target_user),
  );
}

function toolsWithEventTaskTarget(tools: DesktopChatToolSnapshot[], content: Record<string, unknown>) {
  const target = contentTaskTarget(content);
  if (!target) return tools;
  return tools.map((tool) => {
    const name = tool.name.trim().toLowerCase();
    if ((name !== 'task_operator' && name !== 'update_plan') || toolHasTaskTarget(tool)) return tool;
    return {
      ...tool,
      arguments: JSON.stringify({ ...safeToolArguments(tool.arguments), taskTarget: target }),
    };
  });
}

export function directBridgeSourceEventForOutreachDuplicate(message: CanonicalSessionMessage) {
  if (message.sourceTransport !== 'desktop-bridge-outreach') return null;
  const sourceEventId = message.sourceEventId?.trim();
  if (!sourceEventId?.startsWith('desktop-bridge-outreach:')) return null;
  if (sourceEventId.endsWith(':join')) return null;
  const sourceWithoutRequestSuffix = sourceEventId.endsWith(':request')
    ? sourceEventId.slice(0, -':request'.length)
    : sourceEventId;
  return sourceWithoutRequestSuffix.replace('desktop-bridge-outreach:', 'desktop-bridge:');
}

export function ownerScopedAgentName(
  identity: CanonicalIdentity | undefined,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
) {
  if (!identity) return undefined;
  if (identity.kind !== 'agent') return selfDisplayName(identity.displayName, identity.id === profileHumanIdentityId);
  const owner = identity.ownerIdentityId ? identityById.get(identity.ownerIdentityId) : undefined;
  if (!owner?.displayName) return identity.displayName;
  return possessiveScopedLabel(owner.displayName, identity.displayName, owner.id === profileHumanIdentityId) ?? identity.displayName;
}

function agentLabelForHumanIdentity(
  identity: CanonicalIdentity | undefined,
  identityById: Map<string, CanonicalIdentity>,
) {
  if (!identity || identity.kind !== 'human') return 'Kordi';
  return [...identityById.values()]
    .find((candidate) => candidate.kind === 'agent' && candidate.ownerIdentityId === identity.id)
    ?.displayName ?? 'Kordi';
}

export function canonicalMessageRole(message: CanonicalSessionMessage, identity?: CanonicalIdentity): Message['role'] {
  if (['system', 'user', 'owned-agent', 'external-agent', 'person'].includes(message.senderRole)) {
    return message.senderRole as Message['role'];
  }
  if (identity?.kind === 'agent') return identity.source === 'local' ? 'owned-agent' : 'external-agent';
  return 'person';
}

export function canonicalMessageIsComplete(message: CanonicalSessionMessage, content: Record<string, unknown>) {
  const status = message.status.toLowerCase();
  const deliveryState = stringValue(content.deliveryState)?.toLowerCase();
  return !['draft', 'sending', 'processing'].includes(status) && deliveryState !== 'processing';
}

export function canonicalUserStatusChip(message: CanonicalSessionMessage, content: Record<string, unknown>) {
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  if (deliveryState) {
    if (deliveryState === 'processing' || deliveryState === 'handed_off_direct' || deliveryState === 'handed_off_mailbox') {
      return 'sent';
    }
    if (deliveryState === 'processing_failed') return 'failed';
    return deliveryState;
  }

  return message.status !== 'sent' ? message.status : undefined;
}

export function restoreMentionTriggerText(text: string, content: Record<string, unknown>) {
  if (stringValue(content.kind) !== 'mention-request') return text;
  if (text.trim().startsWith('@')) return text;
  const mentions = Array.isArray(content.mentions) ? content.mentions : [];
  const firstMention = contentRecord(mentions[0]);
  const targetDisplayName = stringValue(content.targetDisplayName)?.trim()
    || stringValue(firstMention.label)?.trim();
  if (!targetDisplayName) return text;
  return `@${targetDisplayName}${text.trim() ? ` ${text.trim()}` : ''}`;
}

export function delegationTerminalStatus(status: string) {
  return ['complete', 'completed', 'failed', 'cancelled', 'timeout'].includes(status.trim().toLowerCase());
}

export function delegationOptimisticFallbackKey(exchange: CanonicalSessionState['delegatedExchanges'][number]) {
  if (!exchange.requestMessageId) return null;
  return [exchange.sessionId, exchange.targetIdentityId, exchange.requestMessageId].join(':');
}

function bridgeAgentRequestControlForExchange(
  exchange: CanonicalSessionState['delegatedExchanges'][number],
  profileHumanIdentityId?: string | null,
) {
  if (exchange.initiatorIdentityId !== profileHumanIdentityId) return undefined;
  const conversationId = exchange.bridgeConversationId?.trim();
  const requestId = exchange.bridgeRequestId?.trim();
  if (!conversationId || !requestId) return undefined;
  return { conversationId, requestId };
}

function agentRoleForViewer(target: CanonicalIdentity, profileHumanIdentityId?: string | null) {
  const profileId = profileHumanIdentityId?.trim();
  return target.source === 'local' || (Boolean(profileId) && target.ownerIdentityId === profileId)
    ? 'owned-agent' as const
    : 'external-agent' as const;
}

export function processingAgentMessage(
  exchange: CanonicalSessionState['delegatedExchanges'][number],
  target: CanonicalIdentity,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
): Message {
  const role = agentRoleForViewer(target, profileHumanIdentityId);
  const time = formatDesktopClockTime(exchange.createdAtMs);
  const pendingBridgeAgentRequest = bridgeAgentRequestControlForExchange(exchange, profileHumanIdentityId);
  const replyToMessageId = exchange.requestMessageId?.trim() || exchange.triggerMessageId?.trim() || null;
  return {
    id: `canonical-delegation-processing:${exchange.id}`,
    role,
    sender: ownerScopedAgentName(target, identityById, profileHumanIdentityId) ?? target.displayName,
    senderType: 'agent',
    senderProfileImageUrl: target.profileImageUrl ?? null,
    senderAvatarSeed: target.avatarKey ?? null,
    isOwnMessage: false,
    showSenderMeta: role === 'external-agent',
    text: '',
    time,
    replyToMessageId,
    turn: {
      id: `canonical-delegation-processing:${exchange.id}`,
      sessionId: exchange.sessionId,
      prompt: '',
      status: 'processing',
      message: 'Processing…',
      assistantText: '',
      thinkingText: '',
      tools: [],
      completed: false,
      succeeded: false,
      error: null,
      replyToMessageId,
      pendingBridgeAgentRequest,
    },
  };
}

export function cancelledBridgeAgentDelegationMessage(
  exchange: CanonicalSessionState['delegatedExchanges'][number],
  target: CanonicalIdentity,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
): Message | null {
  if (exchange.initiatorIdentityId !== profileHumanIdentityId) return null;
  if (!exchange.bridgeConversationId?.trim() || !exchange.bridgeRequestId?.trim()) return null;
  const role = agentRoleForViewer(target, profileHumanIdentityId);
  const time = formatDesktopClockTime(exchange.createdAtMs);
  const replyToMessageId = exchange.requestMessageId?.trim() || exchange.triggerMessageId?.trim() || null;
  return {
    id: `canonical-delegation-cancelled:${exchange.id}`,
    role,
    sender: ownerScopedAgentName(target, identityById, profileHumanIdentityId) ?? target.displayName,
    senderType: 'agent',
    senderProfileImageUrl: target.profileImageUrl ?? null,
    senderAvatarSeed: target.avatarKey ?? null,
    isOwnMessage: false,
    showSenderMeta: role === 'external-agent',
    text: '',
    time,
    replyToMessageId,
    turn: {
      id: `canonical-delegation-cancelled:${exchange.id}`,
      sessionId: exchange.sessionId,
      prompt: '',
      status: 'cancelled',
      message: 'Stopped',
      assistantText: '',
      thinkingText: '',
      tools: [],
      completed: true,
      succeeded: false,
      error: 'Request stopped',
      replyToMessageId,
    },
  };
}

export type MapCanonicalMessageContext = {
  senderIdentityIdByMessageId?: ReadonlyMap<string, string> | null;
  visibleReplyTargetByMessageId?: ReadonlyMap<string, string> | null;
};

export function mapCanonicalMessage(
  message: CanonicalSessionMessage,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  context: MapCanonicalMessageContext = {},
): Message | null {
  const content = contentRecord(message.content);
  if (stringValue(content.kind) === 'delegation-join-event') return null;
  const identity = identityById.get(message.senderIdentityId);
  const role = canonicalMessageRole(message, identity);
  const isAgentTurn = message.messageKind === 'agent-turn' || role === 'owned-agent' || role === 'external-agent';
  const completed = canonicalMessageIsComplete(message, content);
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  const cancelled = message.status === 'cancelled' || deliveryState === 'cancelled';
  const noProviderFailure = isAgentTurn && isCloudAgentNoProviderConfiguredError(message.contentText || stringValue(content.error) || stringValue(content.detail));
  const failed = message.status === 'failed' || deliveryState === 'failed' || deliveryState === 'processing_failed' || cancelled || noProviderFailure;
  const bridgeAgentFailure = isAgentTurn && failed && message.sourceTransport?.startsWith('desktop-bridge');
  const bridgeConversationId = stringValue(content.bridgeConversationId)?.trim();
  const bridgeRequestId = stringValue(content.requestId)?.trim();
  const parentMessageId = message.parentMessageId?.trim();
  const visibleParentMessageId = parentMessageId
    ? context.visibleReplyTargetByMessageId?.get(parentMessageId) ?? parentMessageId
    : undefined;
  const contentReplyToMessageId = stringValue(content.replyToMessageId)?.trim() || stringValue(content.requestMessageId)?.trim();
  const rawMessageAction = canonicalMessageAction(content.messageAction);
  const replyToMessageId = isAgentTurn
    ? contentReplyToMessageId || (visibleParentMessageId && visibleParentMessageId !== message.id ? visibleParentMessageId : null) || null
    : contentReplyToMessageId || (visibleParentMessageId && visibleParentMessageId !== message.id ? visibleParentMessageId : null) || null;
  const replyAliasIds = [parentMessageId, bridgeRequestId]
    .filter((value): value is string => Boolean(value && value !== message.id));
  const trimmedProfileIdentityId = profileHumanIdentityId?.trim() || null;
  const viewerOwnsAgent = isAgentTurn
    && Boolean(trimmedProfileIdentityId)
    && identity?.kind === 'agent'
    && Boolean(identity.ownerIdentityId)
    && identity.ownerIdentityId === trimmedProfileIdentityId;
  const initiatorIdentityId = (() => {
    if (!isAgentTurn) return null;
    const candidates = [
      replyToMessageId ?? null,
      parentMessageId ?? null,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const sender = context.senderIdentityIdByMessageId?.get(candidate);
      if (sender) return sender;
    }
    return null;
  })();
  const viewerIsInitiator = isAgentTurn
    && Boolean(trimmedProfileIdentityId)
    && Boolean(initiatorIdentityId)
    && initiatorIdentityId === trimmedProfileIdentityId;
  const cloudGroupAgentRequestConversationId = message.sourceTransport?.startsWith('cloud-group-agent')
    ? (bridgeConversationId || cloudGroupAgentConversationId(message.sessionId))
    : null;
  const pendingBridgeAgentRequest = isAgentTurn
    && !completed
    && deliveryState === 'processing'
    && bridgeRequestId
    && (viewerOwnsAgent || viewerIsInitiator)
    ? message.sourceTransport?.startsWith('desktop-bridge') && bridgeConversationId
      ? { conversationId: bridgeConversationId, requestId: bridgeRequestId }
      : cloudGroupAgentRequestConversationId
        ? { conversationId: cloudGroupAgentRequestConversationId, requestId: bridgeRequestId }
        : undefined
    : undefined;
  const tools = toolsWithEventTaskTarget(canonicalTools(content.tools), content);
  const time = stringValue(content.timeLabel) ?? formatDesktopClockTime(message.createdAtMs);
  const scopedAgentSender = ownerScopedAgentName(identity, identityById, profileHumanIdentityId);
  const contentSender = stringValue(content.sender)?.trim();
  const isOwnMessage = role === 'user' || message.senderIdentityId === profileHumanIdentityId;
  const sender = (() => {
    if (identity?.kind === 'agent') {
      const owner = identity.ownerIdentityId ? identityById.get(identity.ownerIdentityId) : undefined;
      if (owner?.displayName && contentSender) {
        return possessiveScopedLabel(owner.displayName, contentSender, owner.id === profileHumanIdentityId) ?? contentSender;
      }
      return scopedAgentSender;
    }
    if (isSelfReferenceName(contentSender) && !isOwnMessage) {
      return identity?.displayName ?? contentSender;
    }
    return selfDisplayName(contentSender || identity?.displayName || scopedAgentSender, isOwnMessage);
  })();
  const thinkingText = role === 'owned-agent' ? stringValue(content.thinkingText) ?? '' : '';
  const hasSharedModelTaskTools = tools.some((tool) => {
    const name = tool.name.trim().toLowerCase();
    return name === 'task_operator' || name === 'update_plan';
  });
  const visibleTools = role === 'owned-agent' || (role === 'external-agent' && hasSharedModelTaskTools) ? tools : [];
  const restoredDisplayText = restoreMentionTriggerText(stripOutreachContextEnvelope(message.contentText), content);
  const rawDisplayText = !isOwnMessage && role === 'person'
    ? rewriteLeadingFirstPersonAgentMention(
      restoredDisplayText,
      identity?.displayName || contentSender,
      agentLabelForHumanIdentity(identity, identityById),
    )
    : restoredDisplayText;
  const isProcessingAgentPlaceholder = isAgentTurn
    && deliveryState === 'processing'
    && isProcessingPlaceholderText(rawDisplayText);
  const displayText = isProcessingAgentPlaceholder || bridgeAgentFailure || noProviderFailure ? '' : rawDisplayText;
  const cancelledByRole = stringValue(content.cancelledByRole)?.trim();
  const cancelledTurnText = cancelled
    ? (displayText.trim() || (cancelledByRole ? `Request canceled by ${cancelledByRole}.` : 'Request canceled.'))
    : '';
  const rawErrorText = stringValue(content.error) ?? (noProviderFailure ? rawDisplayText : null) ?? 'Message failed';
  const agentTurnErrorText = failed
    ? message.sourceTransport?.startsWith('cloud-') || rawErrorText.toLowerCase().includes('cloud fallback')
      ? cloudAgentFallbackErrorNotice({ message: rawErrorText })
      : rawErrorText
    : null;
  const sourceHumanIdentity = identity?.kind === 'agent' && identity.ownerIdentityId
    ? identityById.get(identity.ownerIdentityId)
    : identity;
  const sourceHumanLabel = sourceHumanIdentity?.displayName ?? sender ?? '';
  const sourceAgentIdentity = identity?.kind === 'agent'
    ? identity
    : [...identityById.values()].find((candidate) => candidate.kind === 'agent' && candidate.ownerIdentityId === identity?.id);
  const sourceAgentLabel = ownerScopedAgentName(sourceAgentIdentity, identityById, profileHumanIdentityId)
    ?? sourceAgentIdentity?.displayName
    ?? agentLabelForHumanIdentity(sourceHumanIdentity, identityById);
  const messageAction = canonicalMessageActionWithRealSourceLabel(rawMessageAction, sourceHumanLabel, sourceAgentLabel);
  const sourceMessage = canonicalMessageActionSourceReference(messageAction);

  if (role === 'system' && !displayText.trim()) return null;

  return {
    id: message.id,
    // Surface the canonical message id so the fork affordance can
    // target a specific message in canonical (group/bridge) sessions
    // the same way it targets local session entries.
    entryId: message.id,
    isForkSnapshot: (message.sourceTransport === 'canonical-fork-snapshot' || message.sourceTransport === 'cloud-group-fork-snapshot') || undefined,
    role,
    sender,
    senderType: isAgentTurn || identity?.kind === 'agent' ? 'agent' : 'human',
    senderProfileImageUrl: identity?.profileImageUrl ?? null,
    senderAvatarSeed: identity?.avatarKey ?? null,
    isOwnMessage,
    showSenderMeta: role === 'person' || role === 'external-agent',
    text: isAgentTurn ? '' : displayText,
    time,
    detail: stringValue(content.detail),
    attachments: canonicalAttachments(content.attachments),
    mentions: canonicalMentions(content.mentions),
    replyToMessageId: replyToMessageId ?? undefined,
    replyAliasIds: replyAliasIds.length ? replyAliasIds : undefined,
    readReceiptSummary: isOwnMessage && role === 'user' ? canonicalReadReceiptSummary(content, identityById) : null,
    messageAction,
    sourceMessage,
    statusChips: role === 'user' && canonicalUserStatusChip(message, content) ? [canonicalUserStatusChip(message, content)!] : undefined,
    turn: isAgentTurn
      ? {
          id: `canonical-turn:${message.id}`,
          sessionId: message.sessionId,
          prompt: '',
          status: completed ? (cancelled ? 'cancelled' : failed ? 'failed' : 'complete') : (isProcessingAgentPlaceholder ? 'processing' : displayText.trim() ? 'writing' : 'typing'),
          message: completed ? (cancelled ? cancelledTurnText : failed ? 'Failed' : 'Complete') : (isProcessingAgentPlaceholder ? 'Processing…' : displayText.trim() ? 'Replying…' : 'Typing…'),
          assistantText: cancelled ? cancelledTurnText : displayText,
          thinkingText,
          tools: visibleTools,
          completed,
          succeeded: completed && !failed && visibleTools.every((tool) => !tool.isError),
          error: cancelled ? null : failed ? (bridgeAgentFailure ? 'Message failed' : agentTurnErrorText) : null,
          replyToMessageId,
          pendingBridgeAgentRequest,
        }
      : undefined,
  };
}

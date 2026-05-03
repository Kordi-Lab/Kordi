import type {
  CanonicalIdentity,
  CanonicalSessionMessage,
  CanonicalSessionState,
  DesktopChatToolSnapshot,
  Message,
  MessageAttachment,
  MessageMention,
} from '@/kordi-app/types';
import { isSelfReferenceName, possessiveScopedLabel, rewriteLeadingFirstPersonAgentMention, selfDisplayName } from '@/lib/identityLabels';
import { formatDesktopClockTime } from '@/lib/time';

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
    return [{
      kind,
      name,
      formatLabel: stringValue(record.formatLabel) ?? null,
      previewUrl: stringValue(record.previewUrl) ?? null,
      mimeType: stringValue(record.mimeType) ?? null,
      localPath: stringValue(record.localPath) ?? null,
      sizeBytes: numberValue(record.sizeBytes) ?? null,
    }];
  });

  return attachments.length > 0 ? attachments : undefined;
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
      isError: Boolean(record.isError),
    }];
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
      return 'read';
    }
    if (deliveryState === 'processing_failed') return 'failed';
    return deliveryState;
  }

  return message.status !== 'sent' ? message.status : undefined;
}

export function stripOutreachContextEnvelope(text: string) {
  const match = /^Context:\s*[\s\S]*?\n\s*Request:\s*\n?([\s\S]*)$/i.exec(text.trim());
  return match?.[1]?.trim() || text;
}

export function isProcessingPlaceholderText(text: string) {
  return /^processing(?:\.{0,3}|…)?$/i.test(text.trim());
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

export function processingAgentMessage(
  exchange: CanonicalSessionState['delegatedExchanges'][number],
  target: CanonicalIdentity,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
): Message {
  const role = target.source === 'local' ? 'owned-agent' as const : 'external-agent' as const;
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
  const role = target.source === 'local' ? 'owned-agent' as const : 'external-agent' as const;
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

export function mapCanonicalMessage(
  message: CanonicalSessionMessage,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
): Message | null {
  const content = contentRecord(message.content);
  const identity = identityById.get(message.senderIdentityId);
  const role = canonicalMessageRole(message, identity);
  const isAgentTurn = message.messageKind === 'agent-turn' || role === 'owned-agent' || role === 'external-agent';
  const completed = canonicalMessageIsComplete(message, content);
  const deliveryState = stringValue(content.deliveryState)?.trim().toLowerCase();
  const cancelled = message.status === 'cancelled' || deliveryState === 'cancelled';
  const failed = message.status === 'failed' || deliveryState === 'failed' || deliveryState === 'processing_failed' || cancelled;
  const bridgeAgentFailure = isAgentTurn && failed && message.sourceTransport?.startsWith('desktop-bridge');
  const bridgeConversationId = stringValue(content.bridgeConversationId)?.trim();
  const bridgeRequestId = stringValue(content.requestId)?.trim();
  const parentMessageId = message.parentMessageId?.trim();
  const contentReplyToMessageId = stringValue(content.replyToMessageId)?.trim() || stringValue(content.requestMessageId)?.trim();
  const replyToMessageId = isAgentTurn
    ? contentReplyToMessageId || (parentMessageId && parentMessageId !== message.id ? parentMessageId : null) || null
    : null;
  const replyAliasIds = [parentMessageId, bridgeRequestId]
    .filter((value): value is string => Boolean(value && value !== message.id));
  const pendingBridgeAgentRequest = isAgentTurn
    && !completed
    && deliveryState === 'processing'
    && message.sourceTransport?.startsWith('desktop-bridge')
    && bridgeConversationId
    && bridgeRequestId
    ? { conversationId: bridgeConversationId, requestId: bridgeRequestId }
    : undefined;
  const tools = canonicalTools(content.tools);
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
  const visibleTools = role === 'owned-agent' ? tools : [];
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
  const displayText = isProcessingAgentPlaceholder || bridgeAgentFailure ? '' : rawDisplayText;

  if (role === 'system' && !displayText.trim()) return null;

  return {
    id: message.id,
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
    statusChips: role === 'user' && canonicalUserStatusChip(message, content) ? [canonicalUserStatusChip(message, content)!] : undefined,
    turn: isAgentTurn
      ? {
          id: `canonical-turn:${message.id}`,
          sessionId: message.sessionId,
          prompt: '',
          status: completed ? (cancelled ? 'cancelled' : failed ? 'failed' : 'complete') : (isProcessingAgentPlaceholder ? 'processing' : displayText.trim() ? 'writing' : 'typing'),
          message: completed ? (cancelled ? 'Stopped' : failed ? 'Failed' : 'Complete') : (isProcessingAgentPlaceholder ? 'Processing…' : displayText.trim() ? 'Replying…' : 'Typing…'),
          assistantText: displayText,
          thinkingText,
          tools: visibleTools,
          completed,
          succeeded: completed && !failed && visibleTools.every((tool) => !tool.isError),
          error: cancelled ? 'Request stopped' : failed ? (bridgeAgentFailure ? 'Message failed' : stringValue(content.error) ?? 'Message failed') : null,
          replyToMessageId,
          pendingBridgeAgentRequest,
        }
      : undefined,
  };
}

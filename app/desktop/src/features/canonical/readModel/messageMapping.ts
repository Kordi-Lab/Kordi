import { cancelledTurnContent } from '@/features/chat/cancellation';
import { canonicalMessageRole } from './messageRole';
export { canonicalMessageRole } from './messageRole';
import { canonicalIdentityAvatarSeed } from '@/features/canonical/avatarIdentity';
import { cloudAgentFallbackErrorNotice, isCloudAgentNoProviderConfiguredError } from '@/features/cloud/cloudAgentMessages';
import { cloudDirectMessageDisplayText, parseCloudDirectMessageEnvelope } from '@/features/cloud/cloudDirectMessages';
import { cloudGroupAgentConversationId } from '@/features/cloud/cloudGroupMessages';
import { cloudVoiceMessageMetadataOnly, withoutVoiceAttachment } from '@/features/cloud/cloudVoiceMessage';
import { isProcessingPlaceholderText, stripOutreachContextEnvelope } from '@/features/collaboration/agentPlaceholderText';
import { compatibleSourceConversationId } from '@/features/collaboration/legacyBridgeCompatibility';
import type {
CanonicalIdentity,CanonicalSessionMessage,CanonicalSessionState,
DesktopChatToolSnapshot,Message,MessageActionMetadata,
} from '@/kordi-app/types';
import { isSelfReferenceName, rewriteLeadingFirstPersonAgentMention, selfDisplayName } from '@/lib/identityLabels';
import { formatDesktopClockTime } from '@/lib/time';
import { agentMessagePresentation, ownerScopedAgentName } from './agentMessagePresentation';
import { canonicalAttachments } from './attachmentMapping';
import { canonicalCallActivity } from './callActivity';
import { canonicalMentions } from './mentionMapping';
import { canonicalMessageAction, canonicalMessageActionSourceReference } from './messageActionMapping';
import { canonicalReadReceiptSummary, contentRecord, numberValue, stringValue } from "./messageContent";
import { canonicalMessageReactionMetadata } from './messageReactionMetadata';
import { isInternalCloudAgentControlMessage, isPlaceholderSessionTitleNotice, isSynchronizationOnlyCloudGroupTitleNotice } from './messageVisibility';

export { ownerScopedAgentName } from './agentMessagePresentation';

export { canonicalAttachments } from './attachmentMapping';
export { isProcessingPlaceholderText,stripOutreachContextEnvelope };

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

export function directCollaborationSourceEventForOutreachDuplicate(message: CanonicalSessionMessage) {
  if (message.sourceTransport !== 'desktop-bridge-outreach') return null;
  const sourceEventId = message.sourceEventId?.trim();
  if (!sourceEventId?.startsWith('desktop-bridge-outreach:')) return null;
  if (sourceEventId.endsWith(':join')) return null;
  const sourceWithoutRequestSuffix = sourceEventId.endsWith(':request')
    ? sourceEventId.slice(0, -':request'.length)
    : sourceEventId;
  return sourceWithoutRequestSuffix.replace('desktop-bridge-outreach:', 'desktop-bridge:');
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
export function canonicalMessageIsComplete(message: CanonicalSessionMessage, content: Record<string, unknown>) {
  const status = message.status.toLowerCase();
  const deliveryState = stringValue(content.deliveryState)?.toLowerCase();
  return !['draft', 'sending', 'queued', 'processing'].includes(status)
    && !['queued', 'processing'].includes(deliveryState ?? '');
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

  return message.status;
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

function collaborationAgentRequestControlForExchange(
  exchange: CanonicalSessionState['delegatedExchanges'][number],
  profileHumanIdentityId?: string | null,
) {
  if (exchange.initiatorIdentityId !== profileHumanIdentityId) return undefined;
  const conversationId = exchange.sourceConversationId?.trim();
  const requestId = exchange.sourceRequestId?.trim();
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
  const pendingCollaborationAgentRequest = collaborationAgentRequestControlForExchange(exchange, profileHumanIdentityId);
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
      message: '',
      assistantText: '',
      thinkingText: '',
      tools: [],
      completed: false,
      succeeded: false,
      error: null,
      replyToMessageId,
      pendingCollaborationAgentRequest,
    },
  };
}

export function cancelledCollaborationAgentDelegationMessage(
  exchange: CanonicalSessionState['delegatedExchanges'][number],
  target: CanonicalIdentity,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
): Message | null {
  if (exchange.initiatorIdentityId !== profileHumanIdentityId) return null;
  if (!exchange.sourceConversationId?.trim() || !exchange.sourceRequestId?.trim()) return null;
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
  if (isPlaceholderSessionTitleNotice(message) || isSynchronizationOnlyCloudGroupTitleNotice(message) || isInternalCloudAgentControlMessage(message)) return null;
  const contentText = message.contentText;
  const storedContent = contentRecord(message.content);
  const normalized = storedContent.schemaVersion === 1 && storedContent.kind === 'message';
  const directEnvelope = normalized ? null : parseCloudDirectMessageEnvelope(contentText);
  const content: Record<string, unknown> = { ...(directEnvelope ?? {}), ...storedContent };
  const sourceTransport = message.sourceTransport?.trim() ?? '';
  if (stringValue(content.kind) === 'delegation-join-event') return null;
  const identity = identityById.get(message.senderIdentityId);
  const role = canonicalMessageRole(message, identity, profileHumanIdentityId);
  const isAgentTurn = message.messageKind === 'agent-turn' || role === 'owned-agent' || role === 'external-agent';
  const completed = canonicalMessageIsComplete(message, content);
  const deliveryState = isAgentTurn && !completed && contentRecord(content.execution).phase === 'queued'
    ? 'queued'
    : stringValue(content.deliveryState)?.trim().toLowerCase();
  const cancelled = message.status === 'cancelled' || deliveryState === 'cancelled';
  const noProviderFailure = isAgentTurn && isCloudAgentNoProviderConfiguredError(contentText || stringValue(content.error) || stringValue(content.detail));
  const failed = message.status === 'failed' || deliveryState === 'failed' || deliveryState === 'processing_failed' || cancelled || noProviderFailure;
  const legacyCollaborationAgentFailure = isAgentTurn && failed && sourceTransport.startsWith('desktop-bridge');
  const sourceConversationId = compatibleSourceConversationId(content)?.trim();
  const sourceRequestId = stringValue(content.requestId)?.trim();
  const desktopEntryId = stringValue(content.desktopEntryId)?.trim()
    || (sourceTransport === 'cloud-self-agent' && message.senderRole === 'user' ? message.sourceEventId?.trim() : undefined);
  const parentMessageId = message.parentMessageId?.trim();
  const visibleParentMessageId = parentMessageId
    ? context.visibleReplyTargetByMessageId?.get(parentMessageId) ?? parentMessageId
    : undefined;
  const contentReplyToMessageId = stringValue(content.replyToMessageId)?.trim() || stringValue(content.requestMessageId)?.trim();
  const rawMessageAction = canonicalMessageAction(content.messageAction);
  const replyToMessageId = isAgentTurn
    ? contentReplyToMessageId || (visibleParentMessageId && visibleParentMessageId !== message.id ? visibleParentMessageId : null) || null
    : contentReplyToMessageId || (visibleParentMessageId && visibleParentMessageId !== message.id ? visibleParentMessageId : null) || null;
  const replyAliasIds = [...new Set([parentMessageId, sourceRequestId, desktopEntryId,
    sourceTransport === 'cloud-self-agent' && message.senderRole === 'user' ? message.sourceEventId : undefined,
    stringValue(content.cloudGroupMessageId)?.trim()]
    .filter((value): value is string => Boolean(value && value !== message.id)))];
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
  const cloudGroupAgentRequestConversationId = sourceTransport.startsWith('cloud-group-agent')
    ? (sourceConversationId || cloudGroupAgentConversationId(message.sessionId))
    : null;
  const pendingCollaborationAgentRequest = isAgentTurn
    && !completed
    && (deliveryState === 'queued' || deliveryState === 'processing')
    && sourceRequestId
    && (viewerOwnsAgent || viewerIsInitiator)
    ? sourceTransport.startsWith('desktop-bridge') && sourceConversationId
      ? { conversationId: sourceConversationId, requestId: sourceRequestId }
      : cloudGroupAgentRequestConversationId
        ? { conversationId: cloudGroupAgentRequestConversationId, requestId: sourceRequestId }
        : undefined
    : undefined;
  const tools = toolsWithEventTaskTarget(canonicalTools(content.tools), content);
  const time = stringValue(content.timeLabel) ?? formatDesktopClockTime(message.createdAtMs);
  const scopedAgentSender = ownerScopedAgentName(identity, identityById, profileHumanIdentityId);
  const contentSender = stringValue(content.sender)?.trim();
  const agentPresentation = agentMessagePresentation(identity, identityById, trimmedProfileIdentityId, contentSender, stringValue(content.senderOwnerName), isAgentTurn);
  const isHostedCloudAgentTurn = isAgentTurn && sourceTransport.startsWith('cloud-group-agent');
  const isOwnMessage = role === 'user' || message.senderIdentityId === profileHumanIdentityId;
  const sender = (() => {
    if (identity?.kind === 'agent') {
      return agentPresentation.sender || scopedAgentSender;
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
  const restoredDisplayText = restoreMentionTriggerText(stripOutreachContextEnvelope(normalized ? contentText : cloudDirectMessageDisplayText(contentText)), content);
  const mentions = canonicalMentions(content.mentions);
  const rawDisplayText = !isOwnMessage && role === 'person'
    ? rewriteLeadingFirstPersonAgentMention(
      restoredDisplayText,
      identity?.displayName || contentSender,
      agentLabelForHumanIdentity(identity, identityById),
      mentions,
    )
    : restoredDisplayText;
  const isProcessingAgentPlaceholder = isAgentTurn
    && (deliveryState === 'queued' || deliveryState === 'processing')
    && (!rawDisplayText.trim() || isProcessingPlaceholderText(rawDisplayText));
  const displayText = isProcessingAgentPlaceholder || legacyCollaborationAgentFailure || noProviderFailure ? '' : rawDisplayText;
  const cancelledByRole = stringValue(content.cancelledByRole)?.trim();
  const cancelledContent = cancelled
    ? cancelledTurnContent(displayText, cancelledByRole ? `Request canceled by ${cancelledByRole}.` : displayText.trim() || 'Request canceled.')
    : null;
  const rawErrorText = stringValue(content.error) ?? (noProviderFailure ? rawDisplayText : null) ?? 'Message failed';
  const agentTurnErrorText = failed
    ? sourceTransport.startsWith('cloud-') || rawErrorText.toLowerCase().includes('cloud fallback')
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
  const sourceAgentLabel = (isHostedCloudAgentTurn && (contentSender || sourceAgentIdentity?.displayName))
    || ownerScopedAgentName(sourceAgentIdentity, identityById, profileHumanIdentityId)
    || sourceAgentIdentity?.displayName
    || agentLabelForHumanIdentity(sourceHumanIdentity, identityById);
  const messageAction = canonicalMessageActionWithRealSourceLabel(rawMessageAction, sourceHumanLabel, sourceAgentLabel);
  const sourceMessage = canonicalMessageActionSourceReference(messageAction);
  if (role === 'system' && !displayText.trim()) return null;
  const voiceMessage = cloudVoiceMessageMetadataOnly(content.voiceMessage);
  return {
    id: message.id,
    // Cloud user messages already carry the runtime entry ID as sourceEventId,
    // before desktop sync enriches their metadata. Use that stable identity
    // rather than text/time matching; runtime admission may cross a minute.
    entryId: sourceTransport === 'canonical-fork-snapshot' ? message.id : desktopEntryId || message.id,
    isForkSnapshot: sourceTransport === 'canonical-fork-snapshot' || undefined,
    role,
    sender,
    senderOwnerName: agentPresentation.senderOwnerName,
    senderIdentityId: message.senderIdentityId,
    senderType: isAgentTurn || identity?.kind === 'agent' ? 'agent' : 'human',
    senderProfileImageUrl: identity?.profileImageUrl ?? null,
    senderAvatarSeed: canonicalIdentityAvatarSeed(identity),
    isOwnMessage,
    showSenderMeta: role === 'person' || role === 'external-agent',
    text: isAgentTurn ? '' : displayText,
    time,
    timestampMs: message.createdAtMs,
    conversationSequence: numberValue(content.conversationSequence),
    callActivity: canonicalCallActivity(message, content, isOwnMessage),
    messageKind: voiceMessage ? 'voice' : role === 'system' ? stringValue(content.kind) ?? message.messageKind : undefined,
    voiceMessage,
    detail: stringValue(content.detail),
    attachments: withoutVoiceAttachment(canonicalAttachments(content.attachments), voiceMessage),
    mentions,
    replyToMessageId: replyToMessageId ?? undefined,
    replyAliasIds: replyAliasIds.length ? replyAliasIds : undefined,
    readReceiptSummary: isOwnMessage && role === 'user' ? canonicalReadReceiptSummary(content, identityById) : null,
    messageAction,
    sourceMessage,
    ...canonicalMessageReactionMetadata(message, content, sourceTransport),
    cloudMessageVersion: numberValue(content.cloudMessageVersion) ?? null, editedAt: stringValue(content.editedAt) ?? null, statusChips: role === 'user' ? [canonicalUserStatusChip(message, content)] : undefined,
    turn: isAgentTurn
      ? {
          id: `canonical-turn:${message.id}`,
          sessionId: message.sessionId,
          prompt: '',
          status: completed ? (cancelled ? 'cancelled' : failed ? 'failed' : 'complete') : (stringValue(content.localExecutionStatus) ?? (isProcessingAgentPlaceholder ? deliveryState === 'queued' ? 'queued' : 'processing' : displayText.trim() ? 'writing' : 'typing')),
          message: completed ? (cancelledContent ? cancelledContent.notice : failed ? 'Failed' : 'Complete') : stringValue(content.localExecutionMessage) ?? (isProcessingAgentPlaceholder ? deliveryState === 'queued' ? 'Queued…' : '' : displayText.trim() ? 'Replying…' : 'Typing…'),
          assistantText: cancelledContent ? cancelledContent.assistantText : displayText,
          thinkingText,
          tools: visibleTools,
          startedAtMs: numberValue(content.startedAtMs), completedAtMs: numberValue(content.completedAtMs),
          completed,
          succeeded: completed && !failed && visibleTools.every((tool) => !tool.isError),
          error: cancelled ? null : failed ? (legacyCollaborationAgentFailure ? 'Message failed' : agentTurnErrorText) : null,
          replyToMessageId,
          pendingCollaborationAgentRequest,
        }
      : undefined,
  };
}

// Every read-model rebuild remaps the whole transcript, so an incoming message
// used to rebuild a view model for all of its history and hand rendering a set
// of fresh objects. Canonical messages are immutable, so a message that still
// resolves the same context can keep its previous result and let rendering skip
// it. Reads are recorded during a miss and revalidated on a hit, so only the
// context a message actually consulted can invalidate it.
type ContextMapName = keyof MapCanonicalMessageContext;
type RecordedRead = { map: ContextMapName; key: string; value: string | undefined };
type MappedMessageCacheEntry = {
  identityById: Map<string, CanonicalIdentity>;
  profileHumanIdentityId: string | null | undefined;
  reads: RecordedRead[];
  result: Message | null;
};

const mappedMessages = new WeakMap<CanonicalSessionMessage, MappedMessageCacheEntry>();

// Records which entries a mapping consulted. A proxy keeps the real map's
// behaviour intact, so a future lookup through has(), size or iteration still
// works rather than meeting an object that only carries get().
function recordingContextMap(
  map: ReadonlyMap<string, string> | null | undefined,
  name: ContextMapName,
  reads: RecordedRead[],
): ReadonlyMap<string, string> | null | undefined {
  if (!map) return map;
  return new Proxy(map, {
    get(target, property, receiver) {
      if (property === 'get') {
        return (key: string) => {
          const value = target.get(key);
          reads.push({ map: name, key, value });
          return value;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function mapCanonicalMessageCached(
  message: CanonicalSessionMessage,
  identityById: Map<string, CanonicalIdentity>,
  profileHumanIdentityId?: string | null,
  context: MapCanonicalMessageContext = {},
): Message | null {
  const cached = mappedMessages.get(message);
  if (
    cached
    && cached.identityById === identityById
    && cached.profileHumanIdentityId === profileHumanIdentityId
    && cached.reads.every((read) => context[read.map]?.get(read.key) === read.value)
  ) return cached.result;
  const reads: RecordedRead[] = [];
  const result = mapCanonicalMessage(message, identityById, profileHumanIdentityId, {
    senderIdentityIdByMessageId: recordingContextMap(
      context.senderIdentityIdByMessageId,
      'senderIdentityIdByMessageId',
      reads,
    ),
    visibleReplyTargetByMessageId: recordingContextMap(
      context.visibleReplyTargetByMessageId,
      'visibleReplyTargetByMessageId',
      reads,
    ),
  });
  mappedMessages.set(message, { identityById, profileHumanIdentityId, reads, result });
  return result;
}

export { contentRecord,numberValue,stringValue } from "./messageContent";

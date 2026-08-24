import { convertFileSrc } from '@tauri-apps/api/core';

import type { Conversation, ConversationCollaborationTarget, DesktopCollaborationConversation, DesktopCollaborationConversationMessage, DesktopCollaborationHost, DesktopCollaborationOutreachMetadata, Message, MessageAttachment, MessageMention } from '@/kordi-app/types';
import {
  COLLABORATION_MESSAGE_DIRECTION_INBOUND,
  COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE,
  COLLABORATION_MESSAGE_DIRECTION_OUTBOUND,
  COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
} from '@/features/collaboration/messages';
import { isCollaborationAgentRuntime } from '@/features/collaboration/runtime';
import { isProcessingPlaceholderText, stripOutreachContextEnvelope } from '@/features/collaboration/agentPlaceholderText';
import {
  collaborationTimestampIsExpired,
  historicalCollaborationProcessingPlaceholderIds,
  isCollaborationAgentResponseDirection,
} from '@/features/collaboration/collaborationProcessingState';
import { collaborationProfileImageUrl, isCollaborationConversationPersonChat } from '@/features/collaboration/conversationPresentation';
import { normalizeSupportContactMessages } from '@/features/support/supportConversationPresentation';
import { isKordiSupportConversation, KORDI_SUPPORT_AVATAR_URL } from '@/features/support/supportIdentity';
import { DEFAULT_LOCAL_AGENT_AVATAR_SEED } from '@/features/canonical/avatarIdentity';
import { firstPersonPossessiveLabel, rewriteLeadingFirstPersonAgentMention } from '@/lib/identityLabels';
import {
  collaborationHostLabel,
  collaborationOutboundStatusChip,
} from './transcriptStatus';

type CollaborationConversationViewModel = Conversation & { _updatedAtMs?: number };
function isImplicitDirectPersonSessionMessage(outreach: DesktopCollaborationOutreachMetadata) {
  return outreach.targetKind === 'person'
    && (
      outreach.contextPolicy === 'session-message'
      || outreach.contextPolicy === 'session-invite'
      || outreach.contextPolicy === 'session-update'
      || outreach.contextPolicy === 'session-title-update'
    )
    && !outreach.triggerText?.trim();
}

function collaborationMessageOutreachForDisplay(
  conversation: DesktopCollaborationConversation,
  message: DesktopCollaborationConversationMessage,
): DesktopCollaborationOutreachMetadata | null {
  const outreach = message.outreach ?? conversation.outreach;
  const isOutreachRequest = outreach?.sourceRequestId
    && message.requestId === outreach.sourceRequestId
    && (message.direction === COLLABORATION_MESSAGE_DIRECTION_INBOUND || message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND);
  if (!isOutreachRequest) return null;
  return outreach && !isImplicitDirectPersonSessionMessage(outreach) ? outreach : null;
}

function collaborationMessageDisplayText(
  conversation: DesktopCollaborationConversation,
  message: DesktopCollaborationConversationMessage,
) {
  const outreach = collaborationMessageOutreachForDisplay(conversation, message);
  if (outreach?.triggerText?.trim()) {
    return outreach.triggerText.trim();
  }
  if (outreach?.targetDisplayName?.trim()) {
    const requestText = outreach.requestText?.trim() || message.text.trim();
    return `@${outreach.targetDisplayName.trim()}${requestText ? ` ${requestText}` : ''}`;
  }
  return stripOutreachContextEnvelope(message.text);
}

function collaborationAttachmentPreviewUrl(attachment: MessageAttachment) {
  if (attachment.kind !== 'image' || !attachment.localPath) return attachment.previewUrl;
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return attachment.previewUrl;
  try {
    return convertFileSrc(attachment.localPath);
  } catch {
    return attachment.previewUrl;
  }
}

function collaborationMessageAttachments(message: DesktopCollaborationConversationMessage): MessageAttachment[] | undefined {
  if (!message.attachments || message.attachments.length === 0) return undefined;
  return message.attachments.map((attachment) => {
    const previewUrl = collaborationAttachmentPreviewUrl(attachment);
    return previewUrl ? { ...attachment, previewUrl } : attachment;
  });
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

function collaborationMessageActionWithRealSourceLabel(
  action: Message['messageAction'],
  humanSourceLabel: string,
  agentSourceLabel: string,
): Message['messageAction'] {
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

function collaborationMessageActionSourceReference(action: Message['messageAction']): Message['sourceMessage'] {
  if (!action) return null;
  return {
    messageId: action.source.sourceMessageId,
    senderLabel: action.source.senderLabel,
    text: action.source.textPreview,
    mentions: action.source.mentions,
    attachmentCount: action.source.attachmentCount,
    time: action.source.timeLabel ?? null,
  };
}
function collaborationMessageMentions(
  conversation: DesktopCollaborationConversation,
  message: DesktopCollaborationConversationMessage,
): MessageMention[] | undefined {
  if (message.mentions?.length) return message.mentions;
  const outreach = collaborationMessageOutreachForDisplay(conversation, message);
  const label = outreach?.targetDisplayName?.trim();
  if (!outreach || !label) return undefined;
  return [{
    label,
    targetKind: outreach.targetKind,
    sourceHostId: outreach.sourceHostId,
    nodeId: outreach.targetNodeId,
    humanId: outreach.targetHumanId ?? null,
    agentId: outreach.targetAgentId ?? null,
  }];
}
function normalizeDeliveryState(value: string | null | undefined) {
  return value?.trim().toLowerCase() || '';
}

function isActiveOutreachStatus(status: string | null | undefined) {
  const normalized = normalizeDeliveryState(status);
  return normalized === 'sending' || normalized === 'awaitingreply' || normalized === 'processing';
}

function isCancelledCollaborationState(value: string | null | undefined) {
  return normalizeDeliveryState(value) === 'cancelled';
}

function isFailedCollaborationState(value: string | null | undefined) {
  return ['failed', 'processing_failed', 'no_response'].includes(normalizeDeliveryState(value));
}

function isTerminalAgentRequestState(value: string | null | undefined) {
  return ['responded', 'cancelled', 'failed', 'processing_failed', 'no_response'].includes(normalizeDeliveryState(value));
}

function latestOutboundAgentRequestState(conversation: DesktopCollaborationConversation) {
  return [...conversation.messages]
    .reverse()
    .find((message) => message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND && Boolean(message.requestId))
    ?.deliveryState;
}

function isGroupScopedCollaborationMessage(message: DesktopCollaborationConversationMessage) {
  const outreach = message.outreach;
  if (!outreach) return false;
  return outreach.parentSessionKind?.trim().toLowerCase() === 'group'
    || Boolean(outreach.parentGroupSpaceId?.trim())
    || outreach.parentSessionId?.trim().startsWith('session:group:') === true;
}

function isVisibleCollaborationUnreadMessage(message: DesktopCollaborationConversationMessage) {
  const contextPolicy = message.outreach?.contextPolicy?.trim().toLowerCase();
  return contextPolicy !== 'session-invite' && contextPolicy !== 'session-update' && contextPolicy !== 'session-title-update';
}

function realAgentLabelForOwner(ownerLabel: string | null | undefined, fallbackAgentLabel: string) {
  const owner = ownerLabel?.trim();
  if (!owner || owner.toLowerCase() === 'me') return fallbackAgentLabel;
  return `${owner}'s Kordi`;
}

function collaborationUnreadByParentSessionId(conversation: DesktopCollaborationConversation) {
  const unreadCount = Math.max(0, conversation.unreadCount);
  if (unreadCount <= 0) return undefined;

  const unreadByParentSessionId: Record<string, number> = {};
  let countedUnreadMessages = 0;
  for (const message of [...conversation.messages].reverse()) {
    if (countedUnreadMessages >= unreadCount) break;
    if (message.direction !== COLLABORATION_MESSAGE_DIRECTION_INBOUND && message.direction !== COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE) {
      continue;
    }
    countedUnreadMessages += 1;
    if (!isVisibleCollaborationUnreadMessage(message)) continue;
    const parentSessionId = message.outreach?.parentSessionId?.trim()
      || conversation.outreach?.parentSessionId?.trim()
      || conversation.canonicalSessionId?.trim();
    if (!parentSessionId) continue;
    unreadByParentSessionId[parentSessionId] = (unreadByParentSessionId[parentSessionId] ?? 0) + 1;
  }

  return Object.keys(unreadByParentSessionId).length > 0 ? unreadByParentSessionId : undefined;
}

export function mapCollaborationConversationToViewModel(
  conversation: DesktopCollaborationConversation,
  host: DesktopCollaborationHost | undefined,
  localAgentLabel: string,
  nowMs: number = Date.now(),
): CollaborationConversationViewModel {
  const hostLabel = collaborationHostLabel(host);
  const isSupportContact = isKordiSupportConversation(conversation);
  const isPersonChat = isSupportContact || isCollaborationConversationPersonChat(conversation);
  const isCloudSelfAgent = conversation.hostId === 'cloud'
    && conversation.peerNodeId === conversation.identity?.localHumanId
    && conversation.identity?.remoteAgentId === conversation.identity?.localAgentId;
  const isAgent = !isPersonChat && isCollaborationAgentRuntime(conversation.peerRuntime);
  const hasSentCollaborationRequest = Boolean(conversation.outreach?.sourceRequestId)
    || conversation.messages.some((message) => Boolean(message.requestId));
  const staleProcessingPlaceholderIds = historicalCollaborationProcessingPlaceholderIds(
    conversation,
    nowMs,
    (message) => collaborationMessageDisplayText(conversation, message),
  );
  const latestAgentRequestState = latestOutboundAgentRequestState(conversation);
  const latestRequestTimestampMs = [...conversation.messages]
    .reverse()
    .find((message) => (
      message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND
      && Boolean(message.requestId?.trim())
    ))?.timestampMs;
  const awaitingReplyFromSentRequest = conversation.awaitingReply
    && hasSentCollaborationRequest
    && !isTerminalAgentRequestState(latestAgentRequestState)
    && !(
      latestRequestTimestampMs
      && collaborationTimestampIsExpired(latestRequestTimestampMs, nowMs)
    );
  const activeAgentReplyMessage = awaitingReplyFromSentRequest
    ? [...conversation.messages].reverse().find((message) => (
        isCollaborationAgentResponseDirection(message)
        && normalizeDeliveryState(message.deliveryState) === 'processing'
        && !staleProcessingPlaceholderIds.has(message.id)
      ))
    : undefined;
  const localHumanLabel = 'Me';
  const localHumanSourceLabel = conversation.identity?.localHumanName?.trim() || host?.ownerName?.trim() || host?.displayName?.trim() || localHumanLabel;
  const localCollaborationAgentLabel = conversation.identity?.localAgentName?.trim()
    || firstPersonPossessiveLabel(host?.displayName || localAgentLabel, host?.ownerName);
  const localAgentSourceLabel = localCollaborationAgentLabel.trim().toLowerCase() === 'my kordi'
    ? realAgentLabelForOwner(localHumanSourceLabel, localCollaborationAgentLabel)
    : localCollaborationAgentLabel;
  const remoteAgentLabel = conversation.identity?.remoteAgentName?.trim() || conversation.peerDisplayName || conversation.title;
  const remoteHumanLabel = isSupportContact
    ? remoteAgentLabel
    : conversation.peerOwnerName || conversation.peerDisplayName || conversation.title;
  const remoteHumanSourceLabel = isSupportContact
    ? remoteAgentLabel
    : conversation.identity?.remoteHumanName?.trim() || remoteHumanLabel;
  const remoteAgentSourceLabel = remoteAgentLabel.trim().toLowerCase() === 'my kordi'
    ? realAgentLabelForOwner(remoteHumanSourceLabel, remoteAgentLabel)
    : remoteAgentLabel;
  const peer = host?.visiblePeers.find((candidate) => candidate.nodeId === conversation.peerNodeId);
  const localHumanAvatarSeed = host?.humanId || conversation.identity?.localHumanId || host?.ownerName || 'local';
  const localAgentAvatarSeed = DEFAULT_LOCAL_AGENT_AVATAR_SEED;
  const remoteHumanAvatarSeed = peer?.avatarSeed || conversation.identity?.remoteHumanId || peer?.humanId || conversation.peerOwnerName || conversation.peerNodeId;
  const remoteAgentAvatarSeed = conversation.identity?.remoteAgentId || peer?.agentId || conversation.peerNodeId;
  const conversationAvatarSeed = isCloudSelfAgent ? localAgentAvatarSeed : isAgent ? remoteAgentAvatarSeed : remoteHumanAvatarSeed;
  const localHumanProfileImageUrl = collaborationProfileImageUrl(host?.profileImageUrl);
  const remoteHumanProfileImageUrl = isSupportContact
    ? KORDI_SUPPORT_AVATAR_URL
    : collaborationProfileImageUrl(peer?.profileImageUrl);
  const participantAvatarSeeds: Record<string, string> = {
    You: localHumanAvatarSeed,
    [localHumanLabel]: localHumanAvatarSeed,
    [localCollaborationAgentLabel]: localAgentAvatarSeed,
    [remoteHumanLabel]: remoteHumanAvatarSeed,
    [remoteAgentLabel]: remoteAgentAvatarSeed,
  };
  const participantProfileImageUrls: Record<string, string | null> = {
    You: localHumanProfileImageUrl,
    [localHumanLabel]: localHumanProfileImageUrl,
    [remoteHumanLabel]: remoteHumanProfileImageUrl,
  };
  const collaborationViewMessageId = (message: DesktopCollaborationConversationMessage) => `collaboration-message:${conversation.id}:${message.id}`;
  const requestMessageIdByRequestId = new Map<string, string>();
  for (const message of conversation.messages) {
    const requestId = message.requestId?.trim();
    if (!requestId) continue;
    if (message.direction !== COLLABORATION_MESSAGE_DIRECTION_OUTBOUND && message.direction !== COLLABORATION_MESSAGE_DIRECTION_INBOUND) continue;
    if (!requestMessageIdByRequestId.has(requestId)) {
      requestMessageIdByRequestId.set(requestId, collaborationViewMessageId(message));
    }
  }

  const awaitingAgentOutreach = conversation.outreach?.targetKind === 'agent'
    && isActiveOutreachStatus(conversation.outreach.status)
    && !isTerminalAgentRequestState(conversation.outreach.deliveryState)
    && hasSentCollaborationRequest
    && !collaborationTimestampIsExpired(
      conversation.outreach.updatedAtMs || conversation.outreach.createdAtMs,
      nowMs,
    );
  const outreachAgentLabel = conversation.outreach?.targetDisplayName || remoteAgentLabel;
  const outreachAgentAvatarSeed = conversation.outreach?.targetAgentId || remoteAgentAvatarSeed;
  const outreachPrefix = conversation.outreach && !isPersonChat
    ? conversation.outreach.targetKind === 'person'
      ? 'Person outreach'
      : 'Agent outreach'
    : null;
  const messages: Message[] = conversation.messages.flatMap((message) => {
    if (isPersonChat && isGroupScopedCollaborationMessage(message)) return [];
    if (staleProcessingPlaceholderIds.has(message.id)) return [];
    const messageId = collaborationViewMessageId(message);
    const replyToMessageId = message.requestId?.trim()
      ? requestMessageIdByRequestId.get(message.requestId.trim()) ?? null
      : null;
    const rawDisplayText = collaborationMessageDisplayText(conversation, message);
    const mentions = collaborationMessageMentions(conversation, message);
    const attachments = collaborationMessageAttachments(message);
    const normalizedDeliveryState = normalizeDeliveryState(message.deliveryState);
    if (message.messageKind === 'agent-model-change') {
      return [{
        id: messageId,
        role: 'system' as const,
        text: rawDisplayText,
        time: message.timeLabel,
        timestampMs: message.timestampMs,
      }];
    }
    const isProcessingAgentPlaceholder = normalizedDeliveryState === 'processing'
      && isProcessingPlaceholderText(rawDisplayText)
      && isCollaborationAgentResponseDirection(message);
    const isOutboundHuman = message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND;
    const displayText = isProcessingAgentPlaceholder
      ? ''
      : !isOutboundHuman
        ? rewriteLeadingFirstPersonAgentMention(rawDisplayText, message.sender || remoteHumanLabel, isPersonChat ? 'Kordi' : remoteAgentLabel)
        : rawDisplayText;
    const isInboundHuman = isAgent && message.direction === COLLABORATION_MESSAGE_DIRECTION_INBOUND;
    const isLocalAgentResponse = message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE;
    const isRemoteAgentResponse = message.direction === COLLABORATION_MESSAGE_DIRECTION_INBOUND_RESPONSE;
    const actionOwnerIsLocal = message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND
      || message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND_RESPONSE;
    const messageAction = collaborationMessageActionWithRealSourceLabel(
      message.messageAction ?? null,
      actionOwnerIsLocal ? localHumanSourceLabel : remoteHumanSourceLabel,
      actionOwnerIsLocal ? localAgentSourceLabel : remoteAgentSourceLabel,
    );
    const sourceMessage = collaborationMessageActionSourceReference(messageAction);
    const sender = isAgent
      ? isOutboundHuman
        ? localHumanLabel
        : isInboundHuman
          ? remoteHumanLabel
          : isLocalAgentResponse
            ? localCollaborationAgentLabel
            : remoteAgentLabel
      : (message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND ? localHumanLabel : remoteHumanLabel);
    const senderType = (isOutboundHuman || isInboundHuman || !isAgent) ? 'human' : 'agent';
    const senderAvatarSeed = isAgent
      ? isOutboundHuman
        ? localHumanAvatarSeed
        : isInboundHuman
          ? remoteHumanAvatarSeed
          : isLocalAgentResponse
            ? localAgentAvatarSeed
            : remoteAgentAvatarSeed
      : message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND
        ? localHumanAvatarSeed
        : remoteHumanAvatarSeed;
    const senderProfileImageUrl = senderType === 'human'
      ? isOutboundHuman
        ? localHumanProfileImageUrl
        : remoteHumanProfileImageUrl
      : null;
    const agentHasBegunReply = Boolean(activeAgentReplyMessage) || conversation.peerTyping;
    const outboundStatus = [collaborationOutboundStatusChip(message.deliveryState, agentHasBegunReply)]
      .filter(Boolean);
    const isLiveAgentReply = (isRemoteAgentResponse || isLocalAgentResponse) && normalizedDeliveryState === 'processing';

    if (isRemoteAgentResponse || isLocalAgentResponse) {
      const responseSender = (isSupportContact && isRemoteAgentResponse ? remoteAgentLabel : message.sender?.trim())
        || (isRemoteAgentResponse ? remoteAgentLabel : localCollaborationAgentLabel);
      const responseCancelled = isCancelledCollaborationState(message.deliveryState);
      const responseFailed = isFailedCollaborationState(message.deliveryState);
      const localTurn = message.localTurn ?? null;
      return [{
        id: messageId,
        role: isRemoteAgentResponse ? 'external-agent' as const : 'owned-agent' as const,
        sender: responseSender,
        sourceSenderLabel: isRemoteAgentResponse ? remoteAgentSourceLabel : localAgentSourceLabel,
        senderType: 'agent',
        isOwnMessage: false,
        showSenderMeta: true,
        senderAvatarSeed: isRemoteAgentResponse ? remoteAgentAvatarSeed : localAgentAvatarSeed,
        senderProfileImageUrl: isSupportContact && isRemoteAgentResponse
          ? KORDI_SUPPORT_AVATAR_URL
          : null,
        text: '',
        time: message.timeLabel,
        timestampMs: message.timestampMs,
        replyToMessageId, reactionConversationId: message.reactionConversationId, reactionTargetMessageId: message.reactionTargetMessageId, reactions: message.reactions,
        turn: {
          id: localTurn?.id ?? `collaboration-live-turn:${conversation.id}:${message.id}`,
          sessionId: conversation.id,
          prompt: localTurn?.prompt ?? '',
          status: responseCancelled ? 'cancelled' : responseFailed ? 'failed' : isLiveAgentReply ? (isProcessingAgentPlaceholder ? 'processing' : displayText.trim() ? 'writing' : 'typing') : localTurn?.status ?? 'complete',
          message: responseCancelled ? 'Stopped' : responseFailed ? 'Failed' : isLiveAgentReply ? (isProcessingAgentPlaceholder ? 'Processing…' : displayText.trim() ? 'Replying…' : 'Typing…') : localTurn?.message ?? 'Complete',
          assistantText: responseFailed ? '' : responseCancelled && !displayText.trim() ? 'Request stopped' : displayText || localTurn?.assistantText || '',
          thinkingText: localTurn?.thinkingText ?? '',
          tools: localTurn?.tools ?? [],
          completed: responseCancelled || responseFailed || !isLiveAgentReply,
          succeeded: responseCancelled || responseFailed ? false : !isLiveAgentReply ? (localTurn?.succeeded ?? true) : false,
          error: responseFailed ? (displayText || localTurn?.error || 'Message failed') : localTurn?.error ?? null,
          replyToMessageId,
          pendingCollaborationAgentRequest: isLiveAgentReply && message.requestId?.trim() ? {
            conversationId: conversation.id,
            requestId: message.requestId.trim(),
          } : null,
        },
      }];
    }
    const mappedMessage: Message = {
      id: messageId,
      role: isAgent
        ? (isOutboundHuman
            ? 'user'
            : isInboundHuman
              ? 'person'
              : isLocalAgentResponse
                ? 'owned-agent'
                : 'external-agent')
        : ((message.direction === COLLABORATION_MESSAGE_DIRECTION_OUTBOUND ? 'user' : 'person') as Message['role']),
      sender,
      sourceSenderLabel: isOutboundHuman
        ? localHumanSourceLabel
        : senderType === 'human'
          ? remoteHumanSourceLabel
          : isLocalAgentResponse
            ? localAgentSourceLabel
            : remoteAgentSourceLabel,
      senderType,
      isOwnMessage: isOutboundHuman,
      showSenderMeta: isAgent,
      senderAvatarSeed,
      senderProfileImageUrl,
      text: displayText,
      time: message.timeLabel,
      timestampMs: message.timestampMs,
      statusChips: isOutboundHuman
        ? outboundStatus
        : conversation.peerTyping && message === conversation.messages[conversation.messages.length - 1] && !isAgent
          ? ['typing']
          : [],
      mentions,
      attachments,
      messageAction, reactionConversationId: message.reactionConversationId, reactionTargetMessageId: message.reactionTargetMessageId, reactions: message.reactions,
      sourceMessage,
      replyToMessageId: message.messageAction?.kind === 'quote' ? sourceMessage?.messageId ?? null : undefined,
      detail: message.detail ?? undefined,
    };
    if (isAgent && isOutboundHuman && isCancelledCollaborationState(message.deliveryState)) {
      return [mappedMessage, {
        id: `collaboration-live-turn:${conversation.id}:${message.id}:cancelled`,
        role: 'external-agent' as const,
        sender: remoteAgentLabel,
        senderType: 'agent' as const,
        isOwnMessage: false,
        showSenderMeta: true,
        senderAvatarSeed: remoteAgentAvatarSeed,
        text: '',
        time: message.timeLabel,
        timestampMs: message.timestampMs,
        replyToMessageId,
        turn: {
          id: `collaboration-live-turn:${conversation.id}:${message.id}:cancelled`,
          sessionId: conversation.id,
          prompt: '',
          status: 'cancelled',
          message: 'Stopped',
          assistantText: 'Request stopped',
          thinkingText: '',
          tools: [],
          completed: true,
          succeeded: false,
          error: null,
          replyToMessageId,
        },
      }];
    }
    return [mappedMessage];
  });
  if ((((isAgent || isSupportContact) && awaitingReplyFromSentRequest) || awaitingAgentOutreach) && !activeAgentReplyMessage) {
    const outreachRequestId = conversation.outreach?.sourceRequestId?.trim();
    const requestMessageIds = [...requestMessageIdByRequestId.values()];
    const replyToMessageId = outreachRequestId
      ? requestMessageIdByRequestId.get(outreachRequestId) ?? null
      : requestMessageIds[requestMessageIds.length - 1] ?? null;
    const localTurn = conversation.outreach?.localTurn ?? null;
    messages.push({
      id: `collaboration-live-turn:${conversation.id}:processing`,
      role: 'external-agent',
      sender: awaitingAgentOutreach ? outreachAgentLabel : remoteAgentLabel,
      senderType: 'agent',
      isOwnMessage: false,
      showSenderMeta: true,
      senderAvatarSeed: awaitingAgentOutreach ? outreachAgentAvatarSeed : remoteAgentAvatarSeed,
      text: '',
      time: conversation.updatedAtLabel,
      timestampMs: conversation.updatedAtMs,
      replyToMessageId,
      turn: {
        id: localTurn?.id ?? `collaboration-live-turn:${conversation.id}:processing`,
        sessionId: conversation.id,
        prompt: localTurn?.prompt ?? '',
        status: localTurn?.status ?? (conversation.peerTyping ? 'typing' : 'processing'),
        message: localTurn?.message ?? (conversation.peerTyping ? 'Typing…' : 'Processing…'),
        assistantText: localTurn?.assistantText ?? '',
        thinkingText: localTurn?.thinkingText ?? '',
        tools: localTurn?.tools ?? [],
        completed: false,
        succeeded: false,
        error: localTurn?.error ?? null,
        replyToMessageId,
        pendingCollaborationAgentRequest: outreachRequestId ? {
          conversationId: conversation.id,
          requestId: outreachRequestId,
        } : null,
      },
    });
  }

  const collaborationTarget: ConversationCollaborationTarget = {
    hostId: conversation.hostId,
    nodeId: conversation.peerNodeId,
    displayName: isCloudSelfAgent ? localCollaborationAgentLabel : conversation.peerDisplayName,
    ownerName: conversation.peerOwnerName,
    runtime: conversation.peerRuntime,
    humanId: conversation.identity?.remoteHumanId,
    agentId: conversation.identity?.remoteAgentId,
  };
  return {
    id: conversation.id,
    supportTicketEnabled: isSupportContact,
    canonicalSessionId: conversation.canonicalSessionId,
    name: isSupportContact ? remoteAgentLabel : conversation.title,
    type: isCloudSelfAgent ? 'owned-agent' : isAgent ? 'external-agent' : 'person',
    subtitle: outreachPrefix
      ? `${outreachPrefix}${conversation.projectName ? ` • ${conversation.projectName}` : ''} • ${conversation.subtitle || conversation.outreach?.requestText || 'Waiting for reply'}`
      : conversation.projectName
        ? `${conversation.projectName} • ${conversation.subtitle || (isPersonChat ? 'Person chat' : 'Remote agent chat')}`
        : (conversation.subtitle || (isPersonChat ? 'Person chat' : 'Remote agent chat')),
    unread: conversation.unreadCount,
    collaborationSources: conversation.projectName ? [hostLabel, conversation.projectName] : [hostLabel],
    trust: 'Cloud',
    directness: isCloudSelfAgent ? 'Agent chat' : outreachPrefix ?? (isPersonChat ? 'Person chat' : 'Agent chat'),
    participants: isCloudSelfAgent
      ? ['Me', localCollaborationAgentLabel]
      : isSupportContact
        ? ['Me', remoteAgentLabel]
        : isAgent
          ? ['Me', remoteHumanLabel, remoteAgentLabel]
          : ['Me', conversation.peerOwnerName || conversation.title],
    updatedAtLabel: conversation.updatedAtLabel,
    outreach: conversation.outreach,
    identity: conversation.identity,
    avatarSeed: conversationAvatarSeed,
    profileImageUrl: isSupportContact
      ? KORDI_SUPPORT_AVATAR_URL
      : isAgent ? null : remoteHumanProfileImageUrl,
    participantAvatarSeeds,
    participantProfileImageUrls,
    collaborationTarget: collaborationTarget,
    collaborationUnreadByParentSessionId: collaborationUnreadByParentSessionId(conversation),
    messages: isSupportContact ? normalizeSupportContactMessages(messages) : messages,
    _updatedAtMs: conversation.updatedAtMs,
  };
}

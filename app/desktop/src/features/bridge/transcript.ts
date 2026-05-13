import { convertFileSrc } from '@tauri-apps/api/core';

import type { Conversation, ConversationBridgeTarget, DesktopBridgeConversation, DesktopBridgeConversationMessage, DesktopBridgeHost, DesktopBridgeOutreachMetadata, Message, MessageAttachment, MessageMention } from '@/kordi-app/types';
import {
  BRIDGE_MESSAGE_DIRECTION_INBOUND,
  BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE,
  BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
  BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
} from '@/features/bridge/messages';
import { isBridgeAgentRuntime, isBridgePersonRuntime } from '@/features/bridge/runtime';
import { CLOUD_PIXEL_AVATAR_URL_PREFIX, cloudAvatarImageUrl } from '@/features/cloud/avatar';
import { firstPersonPossessiveLabel, rewriteLeadingFirstPersonAgentMention } from '@/lib/identityLabels';

type BridgeConversationViewModel = Conversation & {
  _updatedAtMs?: number;
};

function bridgeHostLabel(host?: DesktopBridgeHost | null) {
  return host?.serverUrl?.replace(/^https?:\/\//, '') || 'Bridge';
}

function bridgeProfileImageUrl(value: string | null | undefined): string | null {
  const normalized = cloudAvatarImageUrl(value);
  if (normalized) return normalized;
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith(CLOUD_PIXEL_AVATAR_URL_PREFIX)) return null;
  return trimmed;
}

function isBridgeConversationPersonChat(conversation: DesktopBridgeConversation) {
  return isBridgePersonRuntime(conversation.peerRuntime)
    || Boolean(
      conversation.peerOwnerName
        && conversation.peerDisplayName
        && conversation.peerOwnerName.trim() === conversation.peerDisplayName.trim(),
    );
}

function bridgeOutboundStatusChip(deliveryState: string | null | undefined, agentHasBegunReply: boolean) {
  const normalized = deliveryState?.trim().toLowerCase();
  if (agentHasBegunReply && (!normalized || normalized === 'sent' || normalized === 'delivered' || normalized === 'processing')) {
    return 'read';
  }
  if (normalized === 'processing' || normalized === 'handed_off_direct' || normalized === 'handed_off_mailbox') {
    return 'read';
  }
  return deliveryState || 'sent';
}

function stripOutreachContextEnvelope(text: string) {
  const match = /^Context:\s*[\s\S]*?\n\s*Request:\s*\n?([\s\S]*)$/i.exec(text.trim());
  return match?.[1]?.trim() || text;
}

function isProcessingPlaceholderText(text: string) {
  return /^processing(?:\.{0,3}|…)?$/i.test(text.trim());
}

function isImplicitDirectPersonSessionMessage(outreach: DesktopBridgeOutreachMetadata) {
  return outreach.targetKind === 'bridge-person'
    && (
      outreach.contextPolicy === 'session-message'
      || outreach.contextPolicy === 'session-invite'
      || outreach.contextPolicy === 'session-update'
      || outreach.contextPolicy === 'session-title-update'
    )
    && !outreach.triggerText?.trim();
}

function bridgeMessageOutreachForDisplay(
  conversation: DesktopBridgeConversation,
  message: DesktopBridgeConversationMessage,
): DesktopBridgeOutreachMetadata | null {
  const outreach = message.outreach ?? conversation.outreach;
  const isOutreachRequest = outreach?.bridgeRequestId
    && message.requestId === outreach.bridgeRequestId
    && (message.direction === BRIDGE_MESSAGE_DIRECTION_INBOUND || message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND);
  if (!isOutreachRequest) return null;
  return outreach && !isImplicitDirectPersonSessionMessage(outreach) ? outreach : null;
}

function bridgeMessageDisplayText(
  conversation: DesktopBridgeConversation,
  message: DesktopBridgeConversationMessage,
) {
  const outreach = bridgeMessageOutreachForDisplay(conversation, message);
  if (outreach?.triggerText?.trim()) {
    return outreach.triggerText.trim();
  }
  if (outreach?.targetDisplayName?.trim()) {
    const requestText = outreach.requestText?.trim() || message.text.trim();
    return `@${outreach.targetDisplayName.trim()}${requestText ? ` ${requestText}` : ''}`;
  }
  return stripOutreachContextEnvelope(message.text);
}

function bridgeAttachmentPreviewUrl(attachment: MessageAttachment) {
  if (attachment.kind !== 'image' || !attachment.localPath) return attachment.previewUrl;
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return attachment.previewUrl;
  try {
    return convertFileSrc(attachment.localPath);
  } catch {
    return attachment.previewUrl;
  }
}

function bridgeMessageAttachments(message: DesktopBridgeConversationMessage): MessageAttachment[] | undefined {
  if (!message.attachments || message.attachments.length === 0) return undefined;
  return message.attachments.map((attachment) => {
    const previewUrl = bridgeAttachmentPreviewUrl(attachment);
    return previewUrl ? { ...attachment, previewUrl } : attachment;
  });
}

function bridgeMessageMentions(
  conversation: DesktopBridgeConversation,
  message: DesktopBridgeConversationMessage,
): MessageMention[] | undefined {
  const outreach = bridgeMessageOutreachForDisplay(conversation, message);
  const label = outreach?.targetDisplayName?.trim();
  if (!outreach || !label) return undefined;
  return [{
    label,
    targetKind: outreach.targetKind,
    bridgeHostId: outreach.bridgeHostId,
    nodeId: outreach.targetNodeId,
    humanId: outreach.targetHumanId ?? null,
    agentId: outreach.targetAgentId ?? null,
  }];
}

function normalizedBridgeState(value: string | null | undefined) {
  return value?.trim().toLowerCase() || '';
}

function isActiveOutreachStatus(status: string | null | undefined) {
  const normalized = normalizedBridgeState(status);
  return normalized === 'sending' || normalized === 'awaitingreply' || normalized === 'processing';
}

function isCancelledBridgeState(value: string | null | undefined) {
  return normalizedBridgeState(value) === 'cancelled';
}

function isFailedBridgeState(value: string | null | undefined) {
  return ['failed', 'processing_failed', 'no_response'].includes(normalizedBridgeState(value));
}

function isTerminalAgentRequestState(value: string | null | undefined) {
  return ['responded', 'cancelled', 'failed', 'processing_failed', 'no_response'].includes(normalizedBridgeState(value));
}

function isBridgeAgentResponseDirection(message: DesktopBridgeConversationMessage) {
  return message.direction === BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
    || message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE;
}

function isBridgeProcessingResponsePlaceholder(
  conversation: DesktopBridgeConversation,
  message: DesktopBridgeConversationMessage,
) {
  return normalizedBridgeState(message.deliveryState) === 'processing'
    && isProcessingPlaceholderText(bridgeMessageDisplayText(conversation, message))
    && isBridgeAgentResponseDirection(message);
}

function historicalBridgeProcessingPlaceholderIds(conversation: DesktopBridgeConversation) {
  const staleIds = new Set<string>();
  conversation.messages.forEach((message, index) => {
    if (!isBridgeProcessingResponsePlaceholder(conversation, message)) return;
    const requestId = message.requestId?.trim();
    const newerMessages = conversation.messages.slice(index + 1);
    const hasMatchingRequest = requestId
      ? conversation.messages.some((candidate) => (
        candidate.requestId?.trim() === requestId
        && (candidate.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND || candidate.direction === BRIDGE_MESSAGE_DIRECTION_INBOUND)
      ))
      : false;
    const hasTerminalResponseForSameRequest = requestId
      ? newerMessages.some((laterMessage) => (
        laterMessage.requestId?.trim() === requestId
        && isBridgeAgentResponseDirection(laterMessage)
        && !isBridgeProcessingResponsePlaceholder(conversation, laterMessage)
      ))
      : false;
    const hasNewerTranscriptActivityWithoutThread = (!requestId || !hasMatchingRequest) && newerMessages.some((laterMessage) => (
      !isBridgeProcessingResponsePlaceholder(conversation, laterMessage)
    ));
    if (hasTerminalResponseForSameRequest || hasNewerTranscriptActivityWithoutThread) staleIds.add(message.id);
  });
  return staleIds;
}

function latestOutboundAgentRequestState(conversation: DesktopBridgeConversation) {
  return [...conversation.messages]
    .reverse()
    .find((message) => message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND && Boolean(message.requestId))
    ?.deliveryState;
}

function isGroupScopedBridgeMessage(message: DesktopBridgeConversationMessage) {
  const outreach = message.outreach;
  if (!outreach) return false;
  return outreach.parentSessionKind?.trim().toLowerCase() === 'group'
    || Boolean(outreach.parentGroupSpaceId?.trim())
    || outreach.parentSessionId?.trim().startsWith('session:group:') === true;
}

function isVisibleBridgeUnreadMessage(message: DesktopBridgeConversationMessage) {
  const contextPolicy = message.outreach?.contextPolicy?.trim().toLowerCase();
  return contextPolicy !== 'session-invite' && contextPolicy !== 'session-update' && contextPolicy !== 'session-title-update';
}

function bridgeUnreadByParentSessionId(conversation: DesktopBridgeConversation) {
  const unreadCount = Math.max(0, conversation.unreadCount);
  if (unreadCount <= 0) return undefined;

  const unreadByParentSessionId: Record<string, number> = {};
  let countedUnreadMessages = 0;
  for (const message of [...conversation.messages].reverse()) {
    if (countedUnreadMessages >= unreadCount) break;
    if (message.direction !== BRIDGE_MESSAGE_DIRECTION_INBOUND && message.direction !== BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE) {
      continue;
    }
    countedUnreadMessages += 1;
    if (!isVisibleBridgeUnreadMessage(message)) continue;
    const parentSessionId = message.outreach?.parentSessionId?.trim()
      || conversation.outreach?.parentSessionId?.trim()
      || conversation.canonicalSessionId?.trim();
    if (!parentSessionId) continue;
    unreadByParentSessionId[parentSessionId] = (unreadByParentSessionId[parentSessionId] ?? 0) + 1;
  }

  return Object.keys(unreadByParentSessionId).length > 0 ? unreadByParentSessionId : undefined;
}

export function mapBridgeConversationToViewModel(
  conversation: DesktopBridgeConversation,
  host: DesktopBridgeHost | undefined,
  localAgentLabel: string,
): BridgeConversationViewModel {
  const hostLabel = bridgeHostLabel(host);
  const isPersonChat = isBridgeConversationPersonChat(conversation);
  const isAgent = !isPersonChat && isBridgeAgentRuntime(conversation.peerRuntime);
  const hasSentBridgeRequest = Boolean(conversation.outreach?.bridgeRequestId)
    || conversation.messages.some((message) => Boolean(message.requestId));
  const staleProcessingPlaceholderIds = historicalBridgeProcessingPlaceholderIds(conversation);
  const latestAgentRequestState = latestOutboundAgentRequestState(conversation);
  const awaitingReplyFromSentRequest = conversation.awaitingReply
    && hasSentBridgeRequest
    && !isTerminalAgentRequestState(latestAgentRequestState);
  const activeAgentReplyMessage = awaitingReplyFromSentRequest
    ? [...conversation.messages].reverse().find((message) => (
        isBridgeAgentResponseDirection(message)
        && normalizedBridgeState(message.deliveryState) === 'processing'
        && !staleProcessingPlaceholderIds.has(message.id)
      ))
    : undefined;
  const localHumanLabel = 'Me';
  const localBridgeAgentLabel = conversation.identity?.localAgentName?.trim()
    || firstPersonPossessiveLabel(host?.displayName || localAgentLabel, host?.ownerName);
  const remoteHumanLabel = conversation.peerOwnerName || conversation.peerDisplayName || conversation.title;
  const remoteAgentLabel = conversation.identity?.remoteAgentName?.trim() || conversation.peerDisplayName || conversation.title;
  const peer = host?.visiblePeers.find((candidate) => candidate.nodeId === conversation.peerNodeId);
  const localHumanAvatarSeed = host?.humanId || conversation.identity?.localHumanId || host?.ownerName || 'local';
  const localAgentAvatarSeed = conversation.identity?.localAgentId || host?.activeAgentId || host?.nodeId || 'local-agent';
  const remoteHumanAvatarSeed = peer?.avatarSeed || conversation.identity?.remoteHumanId || peer?.humanId || conversation.peerOwnerName || conversation.peerNodeId;
  const remoteAgentAvatarSeed = conversation.identity?.remoteAgentId || peer?.agentId || conversation.peerNodeId;
  const conversationAvatarSeed = isAgent ? remoteAgentAvatarSeed : remoteHumanAvatarSeed;
  const localHumanProfileImageUrl = bridgeProfileImageUrl(host?.profileImageUrl);
  const remoteHumanProfileImageUrl = bridgeProfileImageUrl(peer?.profileImageUrl);
  const participantAvatarSeeds: Record<string, string> = {
    You: localHumanAvatarSeed,
    [localHumanLabel]: localHumanAvatarSeed,
    [localBridgeAgentLabel]: localAgentAvatarSeed,
    [remoteHumanLabel]: remoteHumanAvatarSeed,
    [remoteAgentLabel]: remoteAgentAvatarSeed,
  };
  const participantProfileImageUrls: Record<string, string | null> = {
    You: localHumanProfileImageUrl,
    [localHumanLabel]: localHumanProfileImageUrl,
    [remoteHumanLabel]: remoteHumanProfileImageUrl,
  };
  const bridgeViewMessageId = (message: DesktopBridgeConversationMessage) => `bridge-message:${conversation.id}:${message.id}`;
  const requestMessageIdByRequestId = new Map<string, string>();
  for (const message of conversation.messages) {
    const requestId = message.requestId?.trim();
    if (!requestId) continue;
    if (message.direction !== BRIDGE_MESSAGE_DIRECTION_OUTBOUND && message.direction !== BRIDGE_MESSAGE_DIRECTION_INBOUND) continue;
    if (!requestMessageIdByRequestId.has(requestId)) {
      requestMessageIdByRequestId.set(requestId, bridgeViewMessageId(message));
    }
  }

  const awaitingAgentOutreach = conversation.outreach?.targetKind === 'bridge-agent'
    && isActiveOutreachStatus(conversation.outreach.status)
    && !isTerminalAgentRequestState(conversation.outreach.deliveryState)
    && hasSentBridgeRequest;
  const outreachAgentLabel = conversation.outreach?.targetDisplayName || remoteAgentLabel;
  const outreachAgentAvatarSeed = conversation.outreach?.targetAgentId || remoteAgentAvatarSeed;
  const outreachPrefix = conversation.outreach && !isPersonChat
    ? conversation.outreach.targetKind === 'bridge-person'
      ? 'Person outreach'
      : 'Agent outreach'
    : null;
  const messages: Message[] = conversation.messages.flatMap((message) => {
    if (isPersonChat && isGroupScopedBridgeMessage(message)) return [];
    if (staleProcessingPlaceholderIds.has(message.id)) return [];
    const messageId = bridgeViewMessageId(message);
    const replyToMessageId = message.requestId?.trim()
      ? requestMessageIdByRequestId.get(message.requestId.trim()) ?? null
      : null;
    const rawDisplayText = bridgeMessageDisplayText(conversation, message);
    const mentions = bridgeMessageMentions(conversation, message);
    const attachments = bridgeMessageAttachments(message);
    const normalizedDeliveryState = normalizedBridgeState(message.deliveryState);
    const isProcessingAgentPlaceholder = normalizedDeliveryState === 'processing'
      && isProcessingPlaceholderText(rawDisplayText)
      && isBridgeAgentResponseDirection(message);
    const isOutboundHuman = message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND;
    const displayText = isProcessingAgentPlaceholder
      ? ''
      : !isOutboundHuman
        ? rewriteLeadingFirstPersonAgentMention(rawDisplayText, message.sender || remoteHumanLabel, isPersonChat ? 'Kordi' : remoteAgentLabel)
        : rawDisplayText;
    const isInboundHuman = isAgent && message.direction === BRIDGE_MESSAGE_DIRECTION_INBOUND;
    const isLocalAgentResponse = message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE;
    const isRemoteAgentResponse = message.direction === BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE;
    const sender = isAgent
      ? isOutboundHuman
        ? localHumanLabel
        : isInboundHuman
          ? remoteHumanLabel
          : isLocalAgentResponse
            ? localBridgeAgentLabel
            : remoteAgentLabel
      : (message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND ? localHumanLabel : remoteHumanLabel);
    const senderType = (isOutboundHuman || isInboundHuman || !isAgent) ? 'human' : 'agent';
    const senderAvatarSeed = isAgent
      ? isOutboundHuman
        ? localHumanAvatarSeed
        : isInboundHuman
          ? remoteHumanAvatarSeed
          : isLocalAgentResponse
            ? localAgentAvatarSeed
            : remoteAgentAvatarSeed
      : message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND
        ? localHumanAvatarSeed
        : remoteHumanAvatarSeed;
    const senderProfileImageUrl = senderType === 'human'
      ? isOutboundHuman
        ? localHumanProfileImageUrl
        : remoteHumanProfileImageUrl
      : null;
    const agentHasBegunReply = Boolean(activeAgentReplyMessage) || conversation.peerTyping;
    const outboundStatus = [bridgeOutboundStatusChip(message.deliveryState, agentHasBegunReply)]
      .filter(Boolean);
    const isLiveAgentReply = (isRemoteAgentResponse || isLocalAgentResponse) && normalizedDeliveryState === 'processing';

    if (isRemoteAgentResponse || isLocalAgentResponse) {
      const responseSender = message.sender?.trim()
        || (isRemoteAgentResponse ? remoteAgentLabel : localBridgeAgentLabel);
      const responseCancelled = isCancelledBridgeState(message.deliveryState);
      const responseFailed = isFailedBridgeState(message.deliveryState);
      const localTurn = message.localTurn ?? null;
      return [{
        id: messageId,
        role: isRemoteAgentResponse ? 'external-agent' as const : 'owned-agent' as const,
        sender: responseSender,
        senderType: 'agent',
        isOwnMessage: false,
        showSenderMeta: true,
        senderAvatarSeed: isRemoteAgentResponse ? remoteAgentAvatarSeed : localAgentAvatarSeed,
        text: '',
        time: message.timeLabel,
        replyToMessageId,
        turn: {
          id: localTurn?.id ?? `bridge-live-turn:${conversation.id}:${message.id}`,
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
          pendingBridgeAgentRequest: isLiveAgentReply && message.requestId?.trim() ? {
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
        : ((message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND ? 'user' : 'person') as Message['role']),
      sender,
      senderType,
      isOwnMessage: isOutboundHuman,
      showSenderMeta: isAgent,
      senderAvatarSeed,
      senderProfileImageUrl,
      text: displayText,
      time: message.timeLabel,
      statusChips: isOutboundHuman
        ? outboundStatus
        : conversation.peerTyping && message === conversation.messages[conversation.messages.length - 1] && !isAgent
          ? ['typing']
          : [],
      mentions,
      attachments,
      detail: message.detail ?? undefined,
    };

    if (isAgent && isOutboundHuman && isCancelledBridgeState(message.deliveryState)) {
      return [mappedMessage, {
        id: `bridge-live-turn:${conversation.id}:${message.id}:cancelled`,
        role: 'external-agent' as const,
        sender: remoteAgentLabel,
        senderType: 'agent' as const,
        isOwnMessage: false,
        showSenderMeta: true,
        senderAvatarSeed: remoteAgentAvatarSeed,
        text: '',
        time: message.timeLabel,
        replyToMessageId,
        turn: {
          id: `bridge-live-turn:${conversation.id}:${message.id}:cancelled`,
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

  if (((isAgent && awaitingReplyFromSentRequest) || awaitingAgentOutreach) && !activeAgentReplyMessage) {
    const outreachRequestId = conversation.outreach?.bridgeRequestId?.trim();
    const requestMessageIds = [...requestMessageIdByRequestId.values()];
    const replyToMessageId = outreachRequestId
      ? requestMessageIdByRequestId.get(outreachRequestId) ?? null
      : requestMessageIds[requestMessageIds.length - 1] ?? null;
    const localTurn = conversation.outreach?.localTurn ?? null;
    messages.push({
      id: `bridge-live-turn:${conversation.id}:processing`,
      role: 'external-agent',
      sender: awaitingAgentOutreach ? outreachAgentLabel : remoteAgentLabel,
      senderType: 'agent',
      isOwnMessage: false,
      showSenderMeta: true,
      senderAvatarSeed: awaitingAgentOutreach ? outreachAgentAvatarSeed : remoteAgentAvatarSeed,
      text: '',
      time: conversation.updatedAtLabel,
      replyToMessageId,
      turn: {
        id: localTurn?.id ?? `bridge-live-turn:${conversation.id}:processing`,
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
        pendingBridgeAgentRequest: outreachRequestId ? {
          conversationId: conversation.id,
          requestId: outreachRequestId,
        } : null,
      },
    });
  }

  const bridgeTarget: ConversationBridgeTarget = {
    hostId: conversation.hostId,
    nodeId: conversation.peerNodeId,
    displayName: conversation.peerDisplayName,
    ownerName: conversation.peerOwnerName,
    runtime: conversation.peerRuntime,
    humanId: conversation.identity?.remoteHumanId,
    agentId: conversation.identity?.remoteAgentId,
  };

  return {
    id: conversation.id,
    canonicalSessionId: conversation.canonicalSessionId,
    name: conversation.title,
    type: isAgent ? 'external-agent' : 'person',
    subtitle: outreachPrefix
      ? `${outreachPrefix}${conversation.projectName ? ` • ${conversation.projectName}` : ''} • ${conversation.subtitle || conversation.outreach?.requestText || 'Waiting for reply'}`
      : conversation.projectName
        ? `${conversation.projectName} • ${conversation.subtitle || (isPersonChat ? 'Direct human chat' : 'Remote agent thread')}`
        : (conversation.subtitle || (isPersonChat ? 'Direct human chat' : 'Remote agent thread')),
    unread: conversation.unreadCount,
    bridges: conversation.projectName ? [hostLabel, conversation.projectName] : [hostLabel],
    trust: 'Bridge',
    directness: outreachPrefix ?? (isPersonChat ? 'Direct person chat' : 'Agent thread'),
    participants: isAgent
      ? ['Me', remoteHumanLabel, remoteAgentLabel]
      : ['Me', conversation.peerOwnerName || conversation.title],
    updatedAtLabel: conversation.updatedAtLabel,
    outreach: conversation.outreach,
    identity: conversation.identity,
    avatarSeed: conversationAvatarSeed,
    profileImageUrl: isAgent ? null : remoteHumanProfileImageUrl,
    participantAvatarSeeds,
    participantProfileImageUrls,
    bridgeTarget,
    bridgeUnreadByParentSessionId: bridgeUnreadByParentSessionId(conversation),
    messages,
    _updatedAtMs: conversation.updatedAtMs,
  };
}

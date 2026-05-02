import { convertFileSrc } from '@tauri-apps/api/core';

import type { Conversation, ConversationBridgeTarget, DesktopBridgeConversation, DesktopBridgeConversationMessage, DesktopBridgeHost, DesktopBridgeOutreachMetadata, Message, MessageAttachment, MessageMention } from '@/kordi-app/types';
import {
  BRIDGE_MESSAGE_DIRECTION_INBOUND,
  BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE,
  BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
  BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
} from '@/features/bridge/messages';
import { isBridgeAgentRuntime, isBridgePersonRuntime } from '@/features/bridge/runtime';
import { firstPersonPossessiveLabel, rewriteLeadingFirstPersonAgentMention } from '@/lib/identityLabels';

type BridgeConversationViewModel = Conversation & {
  _updatedAtMs?: number;
};

function bridgeHostLabel(host?: DesktopBridgeHost | null) {
  return host?.serverUrl?.replace(/^https?:\/\//, '') || 'Bridge';
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

function isActiveOutreachStatus(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase();
  return normalized === 'sending' || normalized === 'awaitingreply' || normalized === 'processing';
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
  const awaitingReplyFromSentRequest = conversation.awaitingReply && hasSentBridgeRequest;
  const activeAgentReplyMessage = awaitingReplyFromSentRequest
    ? [...conversation.messages].reverse().find((message) => (
        (message.direction === BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE || message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE)
        && message.deliveryState === 'processing'
      ))
    : undefined;
  const localHumanLabel = 'Me';
  const localBridgeAgentLabel = firstPersonPossessiveLabel(host?.displayName || localAgentLabel, host?.ownerName);
  const remoteHumanLabel = conversation.peerOwnerName || conversation.peerDisplayName || conversation.title;
  const remoteAgentLabel = conversation.peerDisplayName || conversation.title;
  const peer = host?.visiblePeers.find((candidate) => candidate.nodeId === conversation.peerNodeId);
  const localHumanAvatarSeed = host?.humanId || conversation.identity?.localHumanId || host?.ownerName || 'local';
  const localAgentAvatarSeed = conversation.identity?.localAgentId || host?.activeAgentId || host?.nodeId || 'local-agent';
  const remoteHumanAvatarSeed = conversation.identity?.remoteHumanId || peer?.humanId || conversation.peerOwnerName || conversation.peerNodeId;
  const remoteAgentAvatarSeed = conversation.identity?.remoteAgentId || peer?.agentId || conversation.peerNodeId;
  const conversationAvatarSeed = isAgent ? remoteAgentAvatarSeed : remoteHumanAvatarSeed;
  const participantAvatarSeeds: Record<string, string> = {
    You: localHumanAvatarSeed,
    [localHumanLabel]: localHumanAvatarSeed,
    [localBridgeAgentLabel]: localAgentAvatarSeed,
    [remoteHumanLabel]: remoteHumanAvatarSeed,
    [remoteAgentLabel]: remoteAgentAvatarSeed,
  };

  const awaitingAgentOutreach = conversation.outreach?.targetKind === 'bridge-agent'
    && isActiveOutreachStatus(conversation.outreach.status)
    && hasSentBridgeRequest;
  const outreachAgentLabel = conversation.outreach?.targetDisplayName || remoteAgentLabel;
  const outreachAgentAvatarSeed = conversation.outreach?.targetAgentId || remoteAgentAvatarSeed;
  const outreachPrefix = conversation.outreach && !isPersonChat
    ? conversation.outreach.targetKind === 'bridge-person'
      ? 'Person outreach'
      : 'Agent outreach'
    : null;
  const messages: Message[] = conversation.messages.map((message) => {
    const rawDisplayText = bridgeMessageDisplayText(conversation, message);
    const mentions = bridgeMessageMentions(conversation, message);
    const attachments = bridgeMessageAttachments(message);
    const isProcessingAgentPlaceholder = message.deliveryState === 'processing'
      && isProcessingPlaceholderText(rawDisplayText)
      && (message.direction === BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE || message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE);
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
    const agentHasBegunReply = Boolean(activeAgentReplyMessage) || conversation.peerTyping;
    const outboundStatus = [bridgeOutboundStatusChip(message.deliveryState, agentHasBegunReply)]
      .filter(Boolean);
    const isLiveAgentReply = (isRemoteAgentResponse || isLocalAgentResponse) && message.deliveryState === 'processing';

    if (isRemoteAgentResponse || isLocalAgentResponse) {
      const responseSender = message.sender?.trim()
        || (isRemoteAgentResponse ? remoteAgentLabel : localBridgeAgentLabel);
      return {
        role: isRemoteAgentResponse ? 'external-agent' as const : 'owned-agent' as const,
        sender: responseSender,
        senderType: 'agent',
        isOwnMessage: false,
        showSenderMeta: true,
        senderAvatarSeed: isRemoteAgentResponse ? remoteAgentAvatarSeed : localAgentAvatarSeed,
        text: '',
        time: message.timeLabel,
        turn: {
          id: `bridge-live-turn:${conversation.id}:${message.id}`,
          sessionId: conversation.id,
          prompt: '',
          status: isLiveAgentReply ? (isProcessingAgentPlaceholder ? 'processing' : displayText.trim() ? 'writing' : 'typing') : 'complete',
          message: isLiveAgentReply ? (isProcessingAgentPlaceholder ? 'Processing…' : displayText.trim() ? 'Replying…' : 'Typing…') : 'Complete',
          assistantText: displayText,
          thinkingText: '',
          tools: [],
          completed: !isLiveAgentReply,
          succeeded: !isLiveAgentReply,
          error: null,
        },
      };
    }

    return {
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
      text: displayText,
      time: message.timeLabel,
      statusChips: isOutboundHuman
        ? outboundStatus
        : conversation.peerTyping && message === conversation.messages[conversation.messages.length - 1] && !isAgent
          ? ['typing']
          : [],
      mentions,
      attachments,
      detail: undefined,
    };
  });

  if (((isAgent && awaitingReplyFromSentRequest) || awaitingAgentOutreach) && !activeAgentReplyMessage) {
    messages.push({
      role: 'external-agent',
      sender: awaitingAgentOutreach ? outreachAgentLabel : remoteAgentLabel,
      senderType: 'agent',
      isOwnMessage: false,
      showSenderMeta: true,
      senderAvatarSeed: awaitingAgentOutreach ? outreachAgentAvatarSeed : remoteAgentAvatarSeed,
      text: '',
      time: conversation.updatedAtLabel,
      turn: {
        id: `bridge-live-turn:${conversation.id}:processing`,
        sessionId: conversation.id,
        prompt: '',
        status: conversation.peerTyping ? 'typing' : 'processing',
        message: conversation.peerTyping ? 'Typing…' : 'Processing…',
        assistantText: '',
        thinkingText: '',
        tools: [],
        completed: false,
        succeeded: false,
        error: null,
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
    participantAvatarSeeds,
    bridgeTarget,
    bridgeUnreadByParentSessionId: bridgeUnreadByParentSessionId(conversation),
    messages,
    _updatedAtMs: conversation.updatedAtMs,
  };
}

import type { Conversation, ConversationBridgeTarget, DesktopBridgeConversation, DesktopBridgeHost, Message } from '@/kordi-app/types';
import {
  BRIDGE_MESSAGE_DIRECTION_INBOUND,
  BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE,
  BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
  BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
} from '@/features/bridge/messages';
import { isBridgeAgentRuntime, isBridgePersonRuntime } from '@/features/bridge/runtime';

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

export function mapBridgeConversationToViewModel(
  conversation: DesktopBridgeConversation,
  host: DesktopBridgeHost | undefined,
  localAgentLabel: string,
): BridgeConversationViewModel {
  const hostLabel = bridgeHostLabel(host);
  const isPersonChat = isBridgeConversationPersonChat(conversation);
  const isAgent = !isPersonChat && isBridgeAgentRuntime(conversation.peerRuntime);
  const activeAgentReplyMessage = isAgent && conversation.awaitingReply
    ? [...conversation.messages].reverse().find((message) => (
        message.direction === BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE && message.deliveryState === 'processing'
      ))
    : undefined;
  const localHumanLabel = host?.ownerName || 'You';
  const localBridgeAgentLabel = host?.displayName || localAgentLabel;
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

  const outreachPrefix = conversation.outreach
    ? conversation.outreach.targetKind === 'bridge-person'
      ? 'Person outreach'
      : 'Agent outreach'
    : null;
  const messages: Message[] = conversation.messages.map((message) => {
    const isOutboundHuman = message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND;
    const isInboundHuman = isAgent && message.direction === BRIDGE_MESSAGE_DIRECTION_INBOUND;
    const isLocalAgentResponse = isAgent && message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE;
    const isRemoteAgentResponse = isAgent && message.direction === BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE;
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
    const outboundStatus = [message.deliveryState || (conversation.awaitingReply ? 'awaiting reply' : 'sent')]
      .filter(Boolean);
    const suppressOutboundLiveStatus = isOutboundHuman
      && isAgent
      && ['processing', 'awaiting reply'].includes((outboundStatus[0] ?? '').toLowerCase());
    const isLiveAgentReply = (isRemoteAgentResponse || isLocalAgentResponse) && message.deliveryState === 'processing';

    if (isRemoteAgentResponse || isLocalAgentResponse) {
      return {
        role: isRemoteAgentResponse ? 'external-agent' as const : 'owned-agent' as const,
        sender: isRemoteAgentResponse ? remoteAgentLabel : localBridgeAgentLabel,
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
          status: isLiveAgentReply ? (message.text.trim() ? 'writing' : 'typing') : 'complete',
          message: isLiveAgentReply ? (message.text.trim() ? 'Replying…' : 'Typing…') : 'Complete',
          assistantText: message.text,
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
      text: message.text,
      time: message.timeLabel,
      statusChips: isOutboundHuman
        ? (suppressOutboundLiveStatus ? [] : outboundStatus)
        : conversation.peerTyping && message === conversation.messages[conversation.messages.length - 1] && !isAgent
          ? ['typing']
          : [],
      detail: undefined,
    };
  });

  if (isAgent && conversation.awaitingReply && !activeAgentReplyMessage) {
    messages.push({
      role: 'external-agent',
      sender: remoteAgentLabel,
      senderType: 'agent',
      isOwnMessage: false,
      showSenderMeta: true,
      senderAvatarSeed: remoteAgentAvatarSeed,
      text: '',
      time: conversation.updatedAtLabel,
      turn: {
        id: `bridge-live-turn:${conversation.id}:typing`,
        sessionId: conversation.id,
        prompt: '',
        status: conversation.peerTyping ? 'typing' : 'writing',
        message: conversation.peerTyping ? 'Typing…' : 'Replying…',
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
      ? ['You', remoteHumanLabel, remoteAgentLabel]
      : ['You', conversation.peerOwnerName || conversation.title],
    updatedAtLabel: conversation.updatedAtLabel,
    outreach: conversation.outreach,
    identity: conversation.identity,
    avatarSeed: conversationAvatarSeed,
    participantAvatarSeeds,
    bridgeTarget,
    messages,
    _updatedAtMs: conversation.updatedAtMs,
  };
}

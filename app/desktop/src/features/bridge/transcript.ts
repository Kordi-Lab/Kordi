import type { Conversation, DesktopBridgeConversation, DesktopBridgeHost, Message } from '@/kordi-app/types';
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
  const peerIdentity = host?.visiblePeers.find((peer) => peer.nodeId === conversation.peerNodeId);
  const localHumanLabel = host?.ownerName || 'You';
  const localHumanAvatarKey = `human:${host?.humanId || host?.ownerName || 'local-human-profile'}`;
  const localAgentNodeId = host?.agents.find((agent) => agent.id === host.activeAgentId)?.nodeId || host?.nodeId || host?.activeAgentId;
  const localAgentAvatarKey = `agent:${localAgentNodeId || 'local-agent'}`;
  const localBridgeAgentLabel = host?.displayName || localAgentLabel;
  const remoteHumanLabel = conversation.peerOwnerName || conversation.peerDisplayName || conversation.title;
  const remoteHumanAvatarKey = `human:${peerIdentity?.humanId || (isPersonChat ? conversation.peerNodeId : (conversation.peerOwnerName || conversation.peerNodeId))}`;
  const remoteAgentAvatarKey = `agent:${peerIdentity?.nodeId || conversation.peerNodeId}`;
  const remoteAgentLabel = conversation.peerDisplayName || conversation.title;

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
    const senderAvatarKey = senderType === 'agent'
      ? (isLocalAgentResponse ? localAgentAvatarKey : remoteAgentAvatarKey)
      : message.direction === BRIDGE_MESSAGE_DIRECTION_OUTBOUND
        ? localHumanAvatarKey
        : remoteHumanAvatarKey;
    const senderOwnerName = senderType === 'agent'
      ? (isLocalAgentResponse ? localHumanAvatarKey : remoteHumanAvatarKey)
      : undefined;
    const outboundStatus = [message.deliveryState || (conversation.awaitingReply ? 'awaiting reply' : 'sent')]
      .filter(Boolean);
    const suppressOutboundLiveStatus = isOutboundHuman
      && isAgent
      && ['processing', 'awaiting reply'].includes((outboundStatus[0] ?? '').toLowerCase());
    const isLiveInboundAgentReply = isRemoteAgentResponse && message.deliveryState === 'processing';

    if (isLiveInboundAgentReply) {
      return {
        role: 'external-agent' as const,
        sender: remoteAgentLabel,
        senderType: 'agent',
        senderAvatarKey: remoteAgentAvatarKey,
        senderOwnerName: remoteHumanAvatarKey,
        isOwnMessage: false,
        showSenderMeta: true,
        text: message.text,
        time: message.timeLabel,
        turn: {
          id: `bridge-live-turn:${conversation.id}:${message.id}`,
          sessionId: conversation.id,
          prompt: '',
          status: message.text.trim() ? 'writing' : 'typing',
          message: message.text.trim() ? 'Replying…' : 'Typing…',
          assistantText: message.text,
          thinkingText: '',
          tools: [],
          completed: false,
          succeeded: false,
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
      senderAvatarKey,
      senderOwnerName,
      isOwnMessage: isOutboundHuman,
      showSenderMeta: isAgent,
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
      senderAvatarKey: remoteAgentAvatarKey,
      senderOwnerName: remoteHumanAvatarKey,
      isOwnMessage: false,
      showSenderMeta: true,
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

  return {
    id: conversation.id,
    name: conversation.title,
    type: isAgent ? 'external-agent' : 'person',
    subtitle: conversation.projectName
      ? `${conversation.projectName} • ${conversation.subtitle || (isPersonChat ? 'Direct human chat' : 'Remote agent thread')}`
      : (conversation.subtitle || (isPersonChat ? 'Direct human chat' : 'Remote agent thread')),
    unread: conversation.unreadCount,
    bridges: conversation.projectName ? [hostLabel, conversation.projectName] : [hostLabel],
    trust: 'Bridge',
    directness: isPersonChat ? 'Direct person chat' : 'Agent thread',
    participants: isAgent
      ? ['You', remoteHumanLabel, remoteAgentLabel]
      : ['You', conversation.peerOwnerName || conversation.title],
    updatedAtLabel: conversation.updatedAtLabel,
    avatarKey: isAgent ? remoteAgentAvatarKey : remoteHumanAvatarKey,
    ownerAvatarKey: isAgent ? remoteHumanAvatarKey : undefined,
    messages,
    _updatedAtMs: conversation.updatedAtMs,
  };
}

import { isBridgeAgentRuntime } from '@/features/bridge/runtime';
import { projectRootFromCanonicalProjectGroupId } from '@/features/canonical/sessionResolver';
import type {
  CanonicalSessionState,
  Conversation,
  DesktopBridgeConversation,
  DesktopBridgeHost,
  DesktopBridgePeer,
  DesktopChatTurnSnapshot,
  Message,
  SessionStatusIndicator,
} from '@/kordi-app/types';

export function canExposeBridgePerson(peer: DesktopBridgePeer) {
  return Boolean(
    isBridgeAgentRuntime(peer.runtime)
      && peer.isDefaultAgent
      && peer.ownerName?.trim()
      && peer.humanId?.trim(),
  );
}

export function toBridgePersonPeer(peer: DesktopBridgePeer): DesktopBridgePeer {
  return {
    ...peer,
    displayName: peer.ownerName?.trim() || peer.displayName,
    runtime: 'person',
    agentId: undefined,
    isDefaultAgent: false,
  };
}

export function visibleBridgePeople(peers: DesktopBridgePeer[]) {
  const people: DesktopBridgePeer[] = [];
  const seen = new Set<string>();

  for (const peer of peers) {
    if (!isBridgeAgentRuntime(peer.runtime)) {
      if (seen.has(peer.nodeId)) continue;
      seen.add(peer.nodeId);
      people.push(peer);
      continue;
    }

    if (!canExposeBridgePerson(peer)) continue;

    const key = peer.humanId?.trim() || peer.ownerName?.trim() || peer.nodeId;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(toBridgePersonPeer(peer));
  }

  return people;
}

export function normalizeBridgeProjectKey(value?: string | null) {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function truncateInlineText(value: string, maxChars = 96) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function buildMessagePreview(message: Message) {
  const text = message.text.trim();
  if (text.length > 0) {
    return text;
  }

  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return '';
  }

  if (attachments.length === 1) {
    return `Attached ${attachments[0].name}`;
  }

  return `${attachments.length} attachments`;
}

export function inlineRequestPreview(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > 140 ? `${normalized.slice(0, 137)}…` : normalized;
}

export function buildOutreachInlineMessages(conversation: DesktopBridgeConversation): Message[] {
  const outreach = conversation.outreach;
  if (!outreach) return [];
  if (outreach.contextPolicy === 'session-relay' || outreach.contextPolicy === 'session-message') return [];

  const isAgent = outreach.targetKind === 'bridge-agent';
  const targetName = outreach.targetDisplayName || conversation.title;
  const avatarSeed = isAgent
    ? outreach.targetAgentId || outreach.targetNodeId
    : outreach.targetHumanId || outreach.targetOwnerName || outreach.targetNodeId;
  const requestPreview = inlineRequestPreview(outreach.requestText);
  const joinText = isAgent ? `${targetName} joined through @` : `${targetName} was involved through @`;
  const messages: Message[] = [{
    role: 'system',
    text: requestPreview ? `${joinText} — “${requestPreview}”` : joinText,
    time: conversation.updatedAtLabel,
  }];

  const cutoffMs = Math.max(0, outreach.createdAtMs - 2_000);
  for (const message of conversation.messages) {
    if (message.timestampMs < cutoffMs) continue;
    if (message.direction !== 'inbound' && message.direction !== 'inbound-response') continue;
    if (isAgent && outreach.bridgeRequestId && message.requestId !== outreach.bridgeRequestId) continue;
    const isProcessingAgent = isAgent && message.deliveryState === 'processing';
    const agentTurn = isAgent
      ? {
          id: `bridge-outreach-live-turn:${conversation.id}:${message.id}`,
          sessionId: outreach.parentSessionId ?? conversation.canonicalSessionId,
          prompt: outreach.requestText,
          status: isProcessingAgent ? (message.text.trim() ? 'writing' : 'typing') : 'complete',
          message: isProcessingAgent ? (message.text.trim() ? 'Replying…' : 'Typing…') : 'Complete',
          assistantText: message.text,
          thinkingText: '',
          tools: [],
          completed: !isProcessingAgent,
          succeeded: !isProcessingAgent,
          error: null,
        }
      : undefined;
    messages.push({
      role: isAgent ? 'external-agent' : 'person',
      sender: targetName,
      senderType: isAgent ? 'agent' : 'human',
      isOwnMessage: false,
      showSenderMeta: true,
      senderAvatarSeed: avatarSeed,
      text: isAgent ? '' : message.text,
      time: message.timeLabel,
      turn: agentTurn,
    });
  }

  return messages;
}

function isRawConversationId(value?: string | null) {
  const trimmed = value?.trim() ?? '';
  return trimmed.startsWith('session:')
    || trimmed.startsWith('bridge:')
    || trimmed.startsWith('draft:');
}

function participantDisplayName(participants: string[]) {
  const nonSelf = participants
    .map((participant) => participant.trim())
    .filter((participant) => participant.length > 0 && !/^(me|you)$/i.test(participant));
  if (nonSelf.length === 1 && /^kordi$/i.test(nonSelf[0])) {
    return undefined;
  }
  return nonSelf[0];
}

function firstUserSentence(messages: Message[]) {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.text.trim().length > 0);
  const text = firstUserMessage?.text.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const sentenceMatch = /^(.+?[.!?。！？])(?:\s|$)/u.exec(text);
  return sentenceMatch?.[1] ?? text.split(/[\n\r]/)[0] ?? text;
}

export function conversationSessionId(conversation: Pick<Conversation, 'id' | 'canonicalSessionId'>) {
  return conversation.canonicalSessionId || conversation.id;
}

function looksLikeSessionId(value: string) {
  return isRawConversationId(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function formatSessionIdSubtitle(value?: string | null) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  if (/^session id:/i.test(trimmed)) return trimmed;
  return looksLikeSessionId(trimmed) ? `Session ID: ${trimmed}` : trimmed;
}

export function conversationDisplayName(conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'name' | 'participants' | 'messages'>) {
  const displayName = conversation.name.trim();
  if (displayName && !isRawConversationId(displayName)) {
    return conversation.name;
  }

  const titleFromMessage = firstUserSentence(conversation.messages);
  if (titleFromMessage) {
    return titleFromMessage;
  }
  return participantDisplayName(conversation.participants) ?? 'New session';
}

export function hideRawConversationIds(conversations: Conversation[]) {
  return conversations.map((conversation) => ({
    ...conversation,
    name: conversationDisplayName(conversation),
    subtitle: conversationSessionId(conversation),
  }));
}

export function buildConversationPreview(messages: Message[], fallback?: string) {
  const latestMessage = [...messages]
    .reverse()
    .find((message) => message.role !== 'system' && buildMessagePreview(message).trim().length > 0);

  if (latestMessage) {
    return truncateInlineText(buildMessagePreview(latestMessage));
  }

  return truncateInlineText(fallback ?? '', 72);
}

export function duplicateAgentTurnKey(message: Message) {
  if (!message.turn) return null;
  const assistantText = message.turn.assistantText.trim();
  const thinkingText = message.turn.thinkingText.trim();
  const toolSignature = message.turn.tools.map((tool) => `${tool.name}:${tool.status}:${tool.resultText ?? ''}`).join('|');
  return [message.role, message.sender ?? '', message.time, assistantText, thinkingText, toolSignature].join('\u0000');
}

function transcriptToolKey(tool: DesktopChatTurnSnapshot['tools'][number]) {
  return tool.id?.trim() || [tool.name, tool.status, tool.arguments, tool.resultText ?? '', tool.isError ? 'error' : 'ok'].join('\u0000');
}

function agentTurnIsSubsumedByNext(current: Message, next: Message) {
  if (!current.turn || !next.turn) return false;
  if (current.role !== next.role || current.sender !== next.sender || current.time !== next.time) return false;
  if (!current.turn.completed || !next.turn.completed) return false;
  if (next.turn.assistantText.trim().length === 0) return false;
  if (current.turn.assistantText.trim().length > 0 && current.turn.assistantText.trim() !== next.turn.assistantText.trim()) return false;

  const currentThinking = current.turn.thinkingText.trim();
  const nextThinking = next.turn.thinkingText.trim();
  if (currentThinking.length > 0 && !nextThinking.includes(currentThinking)) return false;

  if (current.turn.tools.length === 0) return false;
  const nextToolKeys = new Set(next.turn.tools.map(transcriptToolKey));
  return current.turn.tools.every((tool) => nextToolKeys.has(transcriptToolKey(tool)));
}

export function dedupeAdjacentAgentTurns(messages: Message[]) {
  const deduped: Message[] = [];
  let previousAgentTurnKey: string | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const next = messages[index + 1];
    if (next && agentTurnIsSubsumedByNext(message, next)) {
      continue;
    }

    const key = duplicateAgentTurnKey(message);
    if (key && key === previousAgentTurnKey) {
      continue;
    }
    deduped.push(message);
    previousAgentTurnKey = key;
  }

  return deduped;
}

export function preferLatestMessages(mappedMessages: Message[], cachedMessages: Message[] | undefined, preserveCachedMessages: boolean) {
  const messages = !cachedMessages || !preserveCachedMessages
    ? mappedMessages
    : cachedMessages.length >= mappedMessages.length
      ? cachedMessages
      : mappedMessages;
  return dedupeAdjacentAgentTurns(messages);
}

export function buildSessionStatusIndicator({
  unreadCount,
  showBackgroundActivity,
  liveTurn,
  existingIndicator,
}: {
  unreadCount: number;
  showBackgroundActivity: boolean;
  liveTurn?: DesktopChatTurnSnapshot;
  existingIndicator?: SessionStatusIndicator;
}): SessionStatusIndicator | undefined {
  if (existingIndicator?.live) return existingIndicator;
  if (showBackgroundActivity && liveTurn && !liveTurn.completed) {
    if (liveTurn.status === 'cancelling') {
      return { label: 'Stopping', tone: 'stopped', live: true };
    }

    return { label: 'Running', tone: 'running', live: true };
  }

  if (existingIndicator) return existingIndicator;

  if (unreadCount > 0) {
    return { label: 'Unread', tone: 'ready' };
  }

  return undefined;
}

export function canonicalProjectMetadata(session: CanonicalSessionState['sessions'][number]) {
  return session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
    ? session.metadata as Record<string, unknown>
    : {};
}

export function canonicalProjectRoot(session: CanonicalSessionState['sessions'][number]) {
  const metadata = canonicalProjectMetadata(session);
  return typeof metadata.projectRoot === 'string' && metadata.projectRoot.trim().length > 0
    ? metadata.projectRoot.trim()
    : projectRootFromCanonicalProjectGroupId(session.projectId);
}

export function canonicalProjectDisplayName(session: CanonicalSessionState['sessions'][number]) {
  const trimmedProjectName = session.projectName?.trim();
  if (trimmedProjectName) return trimmedProjectName;
  const projectRoot = canonicalProjectRoot(session);
  return projectRoot?.split(/[\\/]/).filter(Boolean).pop() ?? 'Project';
}

export function findBridgeProjectForWorkspace(host: DesktopBridgeHost | null | undefined, projectName?: string | null, projectRoot?: string | null) {
  if (!host) return null;
  const rootLeaf = (projectRoot ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  const candidates = new Set([
    normalizeBridgeProjectKey(projectName),
    normalizeBridgeProjectKey(rootLeaf),
  ].filter(Boolean));
  return host.projects.find((project) => candidates.has(normalizeBridgeProjectKey(project.name))) ?? null;
}

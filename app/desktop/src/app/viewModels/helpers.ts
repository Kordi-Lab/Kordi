import { isCollaborationAgentRuntime } from '@/features/collaboration/runtime';
import { projectRootFromCanonicalProjectGroupId } from '@/features/canonical/sessionResolver';
import { deriveSessionTitle } from '@/features/chat/sessionTitlePolicy';
import { firstPersonPossessiveLabel, stripSelfPossessivePrefix } from '@/lib/identityLabels';
import type {
  CanonicalSessionState,
  ContactRequest,
  Conversation,
  DesktopCollaborationConversation,
  DesktopCollaborationHost,
  DesktopCollaborationPeer,
  DesktopChatTurnSnapshot,
  Message,
  SessionStatusIndicator,
} from '@/kordi-app/types';
import { CHAT_KIND_LABELS, chatKindDescriptionLabel, sessionIdChatKindLabel } from '@/features/chat/sessionKindLabels';

export function canExposeCollaborationPerson(peer: DesktopCollaborationPeer) {
  return Boolean(
    isCollaborationAgentRuntime(peer.runtime)
      && peer.isDefaultAgent
      && peer.ownerName?.trim()
      && peer.humanId?.trim(),
  );
}

export function toCollaborationPersonPeer(peer: DesktopCollaborationPeer): DesktopCollaborationPeer {
  return {
    ...peer,
    displayName: peer.ownerName?.trim() || peer.displayName,
    runtime: 'person',
    agentId: undefined,
    isDefaultAgent: false,
  };
}

export function collaborationPeerIsApprovedContact(peer: DesktopCollaborationPeer) {
  const status = peer.contactRequestStatus?.trim().toLowerCase() ?? '';
  return Boolean(peer.isContact || status === 'contact' || status === 'approved');
}

export function collaborationPeerIsReachableAgent(peer: DesktopCollaborationPeer) {
  if (!isCollaborationAgentRuntime(peer.runtime)) return false;
  const agentReachabilityPolicy = peer.agentReachabilityPolicy?.trim().toLowerCase() || 'contacts';
  return agentReachabilityPolicy !== 'owner';
}

function firstNonEmptyViewModelText(...values: Array<string | null | undefined>) {
  return values.map((value) => value?.trim()).find(Boolean) ?? '';
}

function contactRequestInitials(label: string) {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || '?';
}

export function collaborationContactRequestsForContactsPage(host: DesktopCollaborationHost | null | undefined): ContactRequest[] {
  if (!host) return [];
  return (host.contactRequests ?? [])
    .filter((request) => request.direction === 'incoming' && request.status === 'pending')
    .map((request) => {
      const requesterNodeId = request.requesterNodeId.trim();
      const peer = host.visiblePeers.find((candidate) => candidate.nodeId === requesterNodeId);
      const requesterName = firstNonEmptyViewModelText(
        peer?.ownerName,
        peer?.displayName,
        peer?.humanId,
        requesterNodeId,
        'Kordi user',
      );
      const message = request.message?.trim();
      return {
        id: `collaboration-contact-request:${host.id}:${request.requestId}`,
        initials: contactRequestInitials(requesterName),
        title: `${requesterName} wants to connect`,
        detail: message || `Approve before direct messages and group invites are allowed. Account: ${requesterNodeId}`,
        time: 'Pending approval',
        profileImageUrl: null,
        avatarSeed: peer?.humanId ?? peer?.agentId ?? requesterNodeId,
        source: 'collaboration',
        sourceHostId: host.id,
        sourceRequestId: request.requestId,
        requesterNodeId,
        targetNodeId: request.targetNodeId,
        status: request.status,
        direction: request.direction,
      };
    });
}

export function visibleCollaborationPeople(peers: DesktopCollaborationPeer[]) {
  const people: DesktopCollaborationPeer[] = [];
  const seen = new Set<string>();

  for (const peer of peers) {
    if (!isCollaborationAgentRuntime(peer.runtime)) {
      if (seen.has(peer.nodeId)) continue;
      seen.add(peer.nodeId);
      people.push(peer);
      continue;
    }

    if (!canExposeCollaborationPerson(peer)) continue;

    const key = peer.humanId?.trim() || peer.ownerName?.trim() || peer.nodeId;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(toCollaborationPersonPeer(peer));
  }

  return people;
}

export function normalizeCollaborationProjectKey(value?: string | null) {
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

  const agentResponseText = message.turn?.assistantText.trim() ?? '';
  if (agentResponseText.length > 0) {
    return agentResponseText;
  }

  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return '';
  if (attachments.length === 1) {
    const attachment = attachments[0];
    return attachment.kind === 'image' || attachment.mimeType?.toLowerCase().startsWith('image/')
      ? 'Photo'
      : `Attached ${attachment.name}`;
  }

  return `${attachments.length} attachments`;
}

export function inlineRequestPreview(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > 140 ? `${normalized.slice(0, 137)}…` : normalized;
}

export function buildOutreachInlineMessages(conversation: DesktopCollaborationConversation): Message[] {
  const outreach = conversation.outreach;
  if (!outreach) return [];
  if (
    outreach.contextPolicy === 'session-relay'
    || outreach.contextPolicy === 'session-message'
    || outreach.contextPolicy === 'session-invite'
    || outreach.contextPolicy === 'session-update'
    || outreach.contextPolicy === 'session-title-update'
  ) return [];

  const isAgent = outreach.targetKind === 'agent';
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
    if (isAgent && outreach.sourceRequestId && message.requestId !== outreach.sourceRequestId) continue;
    const isProcessingAgent = isAgent && message.deliveryState === 'processing';
    const agentTurn = isAgent
      ? {
          id: `collaboration-outreach-live-turn:${conversation.id}:${message.id}`,
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
      timestampMs: message.timestampMs,
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

function nonSelfParticipantNames(participants: string[]) {
  return participants
    .map((participant) => participant.trim())
    .filter((participant) => participant.length > 0 && !/^(me|you)$/i.test(participant));
}

function participantDisplayName(participants: string[]) {
  const nonSelf = nonSelfParticipantNames(participants);
  if (nonSelf.length === 1 && /^kordi$/i.test(nonSelf[0])) {
    return undefined;
  }
  return nonSelf[0];
}

function firstUserSentence(messages: Message[]) {
  for (const message of messages.filter((candidate) => candidate.role === 'user')) {
    const title = deriveSessionTitle(message.text);
    if (title) return title;
  }
  return undefined;
}

function legacyFirstUserSentence(messages: Message[]) {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.text.trim().length > 0);
  const text = firstUserMessage?.text.replace(/\s+/gu, ' ').trim();
  if (!text) return undefined;
  const sentenceMatch = /^(.+?[.!?。！？])(?:\s|$)/u.exec(text);
  return sentenceMatch?.[1] ?? text.split(/[\n\r]/u)[0] ?? text;
}

function localOwnedAgentDisplayName(value?: string | null) {
  return firstPersonPossessiveLabel(value || 'Kordi');
}

export function localOwnedAgentSenderLabel(
  conversation: Pick<Conversation, 'canonicalParticipants' | 'participants' | 'messages'>,
  fallback = 'Kordi',
) {
  const canonicalAgent = conversation.canonicalParticipants?.find((participant) => (
    participant.kind === 'agent'
    && participant.source === 'local'
    && participant.name.trim().length > 0
  ));
  if (canonicalAgent) return localOwnedAgentDisplayName(canonicalAgent.name);

  const recentOwnedAgentMessage = [...conversation.messages]
    .reverse()
    .find((message) => message.role === 'owned-agent' && message.sender?.trim());
  if (recentOwnedAgentMessage?.sender?.trim()) return localOwnedAgentDisplayName(recentOwnedAgentMessage.sender);

  const participantName = nonSelfParticipantNames(conversation.participants)
    .find((participant) => !/^kordi$/i.test(participant));
  return localOwnedAgentDisplayName(participantName ?? fallback);
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
  const kindLabel = sessionIdChatKindLabel(trimmed);
  if (kindLabel) return kindLabel;
  const descriptionLabel = chatKindDescriptionLabel(trimmed);
  if (descriptionLabel) return descriptionLabel;
  return looksLikeSessionId(trimmed) ? CHAT_KIND_LABELS.unknown : trimmed;
}

export function conversationDisplayName(conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'name' | 'participants' | 'messages'>) {
  const displayName = conversation.name.trim();
  if (displayName && !isRawConversationId(displayName)) {
    return conversation.name;
  }

  const usesTopicPolicy = conversation.id.startsWith('session:self-agent:')
    || conversation.id.startsWith('session:project:')
    || conversation.id.startsWith('session:fork:')
    || conversation.id.startsWith('draft:');
  const titleFromMessage = usesTopicPolicy
    ? firstUserSentence(conversation.messages)
    : legacyFirstUserSentence(conversation.messages);
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

function comparableAgentTurnSender(message: Message) {
  const sender = message.sender?.trim() ?? '';
  if (message.role !== 'owned-agent') return sender;
  return (stripSelfPossessivePrefix(sender) || sender).toLowerCase();
}

export function duplicateAgentTurnKey(message: Message) {
  if (!message.turn) return null;
  const assistantText = message.turn.assistantText.trim();
  const thinkingText = message.turn.thinkingText.trim();
  const toolSignature = message.turn.tools.map((tool) => `${tool.name}:${tool.status}:${tool.resultText ?? ''}`).join('|');
  return [message.role, comparableAgentTurnSender(message), message.time, assistantText, thinkingText, toolSignature].join('\u0000');
}

function transcriptToolKey(tool: DesktopChatTurnSnapshot['tools'][number]) {
  return tool.id?.trim() || [tool.name, tool.status, tool.arguments, tool.resultText ?? '', tool.isError ? 'error' : 'ok'].join('\u0000');
}

export function suppressLiveTurnEchoMessages(messages: Message[], turn?: DesktopChatTurnSnapshot) {
  if (!turn || turn.completed) return messages;

  const lastUserIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') return index;
    }
    return -1;
  })();

  const filtered = messages.filter((message, index) => {
    if (index <= lastUserIndex) return true;
    if (message.role === 'owned-agent') return false;
    // The legacy collaboration placeholder for an inbound ASK on the agent owner's instance
    // surfaces as an external-agent agent-turn with an in-flight `turn`; the live turn
    // overlay already represents that work. Drop in-flight external-agent rows so the
    // viewer doesn't see a redundant "Processing…" row underneath the live turn.
    if (message.role === 'external-agent' && message.turn && !message.turn.completed) return false;
    return true;
  });

  return filtered.length === messages.length ? messages : filtered;
}

function cleanComparableText(value?: string | null) {
  return value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';
}

function explicitAgentReplyTarget(message: Message) {
  return cleanComparableText(message.replyToMessageId)
    || cleanComparableText(message.turn?.replyToMessageId)
    || cleanComparableText(message.sourceMessage?.messageId)
    || cleanComparableText(message.turn?.sourceMessage?.messageId);
}

function agentTurnsShareRequest(current: Message, next: Message) {
  if (current.time === next.time) return true;

  const currentTarget = explicitAgentReplyTarget(current);
  const nextTarget = explicitAgentReplyTarget(next);
  if (currentTarget && nextTarget && currentTarget === nextTarget) return true;

  const currentPrompt = cleanComparableText(current.turn?.prompt);
  const nextPrompt = cleanComparableText(next.turn?.prompt);
  if (currentPrompt && nextPrompt && currentPrompt === nextPrompt) return true;

  if (!currentPrompt && !nextPrompt) {
    const currentText = cleanComparableText(current.turn?.assistantText);
    const nextText = cleanComparableText(next.turn?.assistantText);
    if (currentText && nextText.startsWith(currentText)) return true;
    return (current.turn?.tools.length ?? 0) === 0;
  }

  return false;
}

function agentTurnIsSubsumedByNext(current: Message, next: Message) {
  if (!current.turn || !next.turn) return false;
  if (current.role !== next.role || comparableAgentTurnSender(current) !== comparableAgentTurnSender(next) || !agentTurnsShareRequest(current, next)) return false;
  if (!current.turn.completed || !next.turn.completed) return false;
  const currentAssistantText = current.turn.assistantText.trim();
  const nextAssistantText = next.turn.assistantText.trim();
  if (nextAssistantText.length === 0) return false;
  if (
    currentAssistantText.length > 0
    && currentAssistantText !== nextAssistantText
    && !nextAssistantText.startsWith(currentAssistantText)
  ) return false;

  const currentThinking = current.turn.thinkingText.trim();
  const nextThinking = next.turn.thinkingText.trim();
  if (currentThinking.length > 0 && !nextThinking.includes(currentThinking)) return false;

  if (current.turn.tools.length === 0) {
    return currentAssistantText.length > 0 || currentThinking.length > 0;
  }
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

export function preferLatestMessages(
  mappedMessages: Message[],
  cachedMessages: Message[] | undefined,
  preserveCachedMessages: boolean,
  liveTurn?: DesktopChatTurnSnapshot,
) {
  const messages = !cachedMessages || !preserveCachedMessages
    ? mappedMessages
    : cachedMessages.length >= mappedMessages.length
      ? cachedMessages
      : mappedMessages;
  const visibleMessages = liveTurn && !liveTurn.completed
    ? suppressLiveTurnEchoMessages(messages, liveTurn)
    : messages;
  return dedupeAdjacentAgentTurns(visibleMessages);
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

export function findCollaborationProjectForWorkspace(host: DesktopCollaborationHost | null | undefined, projectName?: string | null, projectRoot?: string | null) {
  if (!host) return null;
  const rootLeaf = (projectRoot ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  const candidates = new Set([
    normalizeCollaborationProjectKey(projectName),
    normalizeCollaborationProjectKey(rootLeaf),
  ].filter(Boolean));
  return host.projects.find((project) => candidates.has(normalizeCollaborationProjectKey(project.name))) ?? null;
}

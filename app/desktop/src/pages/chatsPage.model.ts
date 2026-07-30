import { conversationChatKindLabel } from '@/features/chat/sessionKindLabels';
import type { ComposerModelOption, ComposerProviderOption } from '@/kordi-app/components';
import type { Conversation, ConversationParticipant, Message } from '@/kordi-app/types';
import type { TranscriptDensityMode } from '@/kordi-app/components/transcript';
import type { DesktopChatContextMessage } from '@/lib/desktop';

export type CompanionSide = 'left' | 'right';

export const CHAT_COMPANION_DRAG_TYPE = 'application/x-kordi-chat-companion';

function cleanKey(value?: string | null) {
  return value?.trim().toLowerCase() ?? '';
}

function participantIsSelf(participant: ConversationParticipant) {
  return participant.role === 'self' || (participant.source === 'local' && participant.kind === 'human');
}

function conversationIsGroupChat(conversation: Conversation) {
  return conversation.canonicalSessionId?.startsWith('session:group:') === true
    || conversation.participantSpaceId?.startsWith('group:') === true
    || /\bgroup\b/i.test(conversation.directness ?? '');
}

function conversationIsHumanChat(conversation: Conversation) {
  return conversationIsGroupChat(conversation) || (!conversationIsAgentChat(conversation) && (
    conversation.type === 'person'
    || conversation.canonicalParticipants?.some((participant) => !participantIsSelf(participant) && participant.kind === 'human') === true
  ));
}

function conversationIsAgentChat(conversation: Conversation) {
  return !conversationIsGroupChat(conversation)
    && (conversation.type === 'owned-agent' || conversation.type === 'external-agent');
}

function conversationUsesCompactHumanTranscriptDensity(conversation: Conversation) {
  if (conversationIsAgentChat(conversation)) return false;
  if (conversationIsGroupChat(conversation)) return true;
  if (conversation.type === 'person') return true;
  const directness = conversation.directness?.trim().toLowerCase() ?? '';
  if (/\b(?:direct|person|contact)\b/.test(directness)) return true;
  const nonSelfHumanCount = (conversation.canonicalParticipants ?? [])
    .filter((participant) => !participantIsSelf(participant) && participant.kind === 'human')
    .length;
  return nonSelfHumanCount === 1;
}

export function chatTranscriptDensityMode(conversation: Conversation): TranscriptDensityMode {
  if (conversationIsAgentChat(conversation)) return 'agent-compact';
  if (conversationIsGroupChat(conversation)) return 'group-compact';
  if (conversationUsesCompactHumanTranscriptDensity(conversation)) return 'contact-compact';
  return 'default';
}

export function transcriptHumanParticipant(
  conversation: Conversation,
  message: Message,
): ConversationParticipant | null {
  if (message.isOwnMessage || message.senderType === 'agent') return null;
  const humanParticipants = (conversation.canonicalParticipants ?? [])
    .filter((participant) => participant.kind === 'human');
  const senderIdentityId = message.senderIdentityId?.trim();
  if (senderIdentityId) {
    const exact = humanParticipants.find((participant) => (
      participant.id === senderIdentityId
      || participant.humanId?.trim() === senderIdentityId
      || participant.sourceIdentityId?.trim() === senderIdentityId
    ));
    if (exact) return exact;
  }
  const senderName = message.sender?.trim().toLocaleLowerCase();
  if (!senderName) return null;
  const nameMatches = humanParticipants.filter((participant) => (
    participant.name.trim().toLocaleLowerCase() === senderName
  ));
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

function addScopedKey(keys: Set<string>, scope: string, value?: string | null) {
  const normalized = cleanKey(value);
  if (normalized) keys.add(`${scope}:${normalized}`);
}

function addPersonRelationshipKey(keys: Set<string>, hostScope: string, value?: string | null) {
  addScopedKey(keys, `${hostScope}:human`, value);
  addScopedKey(keys, `${hostScope}:owner`, value);
}

function conversationRelationshipKeys(conversation: Conversation) {
  const keys = new Set<string>();
  const hostScope = cleanKey(conversation.collaborationTarget?.hostId) || cleanKey(conversation.identity?.sourceHostId) || 'local';

  addPersonRelationshipKey(keys, hostScope, conversation.collaborationTarget?.humanId);
  addScopedKey(keys, `${hostScope}:node`, conversation.collaborationTarget?.nodeId);
  addScopedKey(keys, `${hostScope}:owner`, conversation.collaborationTarget?.ownerName);
  addPersonRelationshipKey(keys, hostScope, conversation.identity?.remoteHumanId);
  addScopedKey(keys, `${hostScope}:node`, conversation.identity?.remoteHumanNodeId);

  for (const participant of conversation.canonicalParticipants ?? []) {
    if (participantIsSelf(participant)) continue;
    addPersonRelationshipKey(keys, hostScope, participant.id);
    addPersonRelationshipKey(keys, hostScope, participant.humanId);
    addPersonRelationshipKey(keys, hostScope, participant.ownerIdentityId);
    addScopedKey(keys, `${hostScope}:node`, participant.sourceIdentityId);

    if (participant.kind === 'human') {
      addScopedKey(keys, `${hostScope}:owner`, participant.name);
      continue;
    }

    addScopedKey(keys, `${hostScope}:owner`, participant.ownerName);
  }

  return keys;
}

function relationshipKeyOverlap(left: Conversation, right: Conversation) {
  const leftKeys = conversationRelationshipKeys(left);
  if (leftKeys.size === 0) return false;
  for (const key of conversationRelationshipKeys(right)) {
    if (leftKeys.has(key)) return true;
  }
  return false;
}

export function pairedCompanionConversation(activeConv: Conversation, conversations: Conversation[]) {
  const wantsAgent = conversationIsHumanChat(activeConv);
  const wantsHuman = conversationIsAgentChat(activeConv);
  if (!wantsAgent && !wantsHuman) return null;

  return conversations.find((conversation) => (
    conversation.id !== activeConv.id
    && (wantsAgent ? conversationIsAgentChat(conversation) : conversationIsHumanChat(conversation))
    && relationshipKeyOverlap(activeConv, conversation)
  )) ?? null;
}

export function chatCompanionCandidates(activeConv: Conversation, conversations: Conversation[] = []) {
  return conversations.filter((conversation) => (
    conversation.id !== activeConv.id
    && conversationIsAgentChat(conversation)
  ));
}

export function chatSideAgentConversationForOpenRequest(
  requestedConversationId: string | null,
  candidates: Conversation[],
) {
  if (!requestedConversationId) return null;
  return candidates.find((conversation) => conversation.id === requestedConversationId) ?? null;
}

export function canonicalHistorySessionIdForConversation(
  conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'desktopRuntimeBacked'>,
) {
  if (conversation.desktopRuntimeBacked) return null;
  return conversation.canonicalSessionId ?? conversation.id;
}

export function parseAskAgentTriggerCommand(text: string) {
  const trimmed = text.trimStart();
  const match = trimmed.match(/^\/ask(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { prompt: match[1]?.trim() ?? '' };
}

function messageTextForReference(message: Message) {
  const text = message.text?.trim() || message.turn?.assistantText?.trim() || message.detail?.trim() || '';
  return text.replace(/\s+/g, ' ').slice(0, 240);
}

export function buildAskAgentSessionReferenceContext(conversation: Conversation, recentLimit = 6) {
  const sessionId = conversation.canonicalSessionId?.trim() || conversation.id;
  const typeLabel = conversation.directness?.trim() || conversation.type || 'chat';
  const participants = (conversation.canonicalParticipants ?? conversation.participants ?? [])
    .map((participant) => (typeof participant === 'string' ? participant : participant.name)?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, 8);
  const recentMessages = conversation.messages
    .filter((message) => message.role !== 'system' && message.role !== 'action')
    .map((message) => ({
      sender: message.sender?.trim() || (message.role === 'user' ? 'Me' : message.role),
      text: messageTextForReference(message),
    }))
    .filter((message) => message.text.length > 0)
    .slice(-Math.max(1, recentLimit));

  return [
    'Reference: Current chat',
    `Session: ${conversation.name}`,
    `Session id: ${sessionId}`,
    `Type: ${typeLabel}`,
    participants.length > 0 ? `Participants: ${participants.join(', ')}` : null,
    recentMessages.length > 0 ? 'Recent messages:' : null,
    ...recentMessages.map((message) => `- ${message.sender}: ${message.text}`),
  ].filter(Boolean).join('\n');
}

export function buildAskAgentSessionReferenceContextMessage(conversation: Conversation, text: string): DesktopChatContextMessage | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const sessionId = conversation.canonicalSessionId?.trim() || conversation.id;
  return {
    id: `ask-agent-reference:${sessionId}`,
    authorName: 'Current chat reference',
    authorKind: 'human',
    text: trimmed,
    createdAtMs: Date.now(),
  };
}

export function forkSourceMessageIds(
  conversation: Pick<Conversation, 'forkedFromMessageId' | 'metadata'>,
): Set<string> {
  const ids = new Set<string>();
  const primaryId = conversation.forkedFromMessageId?.trim();
  if (primaryId) ids.add(primaryId);
  const metadata = conversation.metadata && typeof conversation.metadata === 'object' && !Array.isArray(conversation.metadata)
    ? conversation.metadata as Record<string, unknown>
    : null;
  const fork = metadata?.fork && typeof metadata.fork === 'object' && !Array.isArray(metadata.fork)
    ? metadata.fork as Record<string, unknown>
    : null;
  const metadataPrimaryId = typeof fork?.forkedFromMessageId === 'string'
    ? fork.forkedFromMessageId.trim()
    : '';
  if (metadataPrimaryId) ids.add(metadataPrimaryId);
  if (Array.isArray(fork?.forkedFromMessageAliases)) {
    for (const value of fork.forkedFromMessageAliases) {
      if (typeof value !== 'string') continue;
      const alias = value.trim();
      if (alias) ids.add(alias);
    }
  }
  return ids;
}

export function forkSnapshotBoundaryIndexForMessages(
  messages: readonly Message[],
  sourceMessageIds: ReadonlySet<string>,
): number {
  let lastSnapshotIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const messageIds = [
      message.id,
      message.entryId,
    ].filter((value): value is string => Boolean(value?.trim()));
    if (message.isForkSnapshot || messageIds.some((id) => sourceMessageIds.has(id))) {
      lastSnapshotIndex = index;
    }
  }
  return lastSnapshotIndex;
}

export function companionLabel(conversation: Conversation) {
  return conversationChatKindLabel(conversation);
}

export function conversationPaneKind(conversation: Conversation): 'human' | 'agent' | null {
  if (conversationIsGroupChat(conversation)) return 'human';
  if (conversationIsAgentChat(conversation)) return 'agent';
  if (conversationIsHumanChat(conversation)) return 'human';
  return null;
}

function oppositeCompanionSide(side: CompanionSide): CompanionSide {
  return side === 'left' ? 'right' : 'left';
}

export function chatCompanionSideForPaneKinds(
  activeKind: 'human' | 'agent' | null,
  humanSide: CompanionSide,
): CompanionSide {
  if (activeKind === 'human') return oppositeCompanionSide(humanSide);
  if (activeKind === 'agent') return humanSide;
  return oppositeCompanionSide(humanSide);
}

export function humanSideForCompanionSide(
  activeKind: 'human' | 'agent' | null,
  companionSide: CompanionSide,
): CompanionSide {
  if (activeKind === 'agent') return companionSide;
  return oppositeCompanionSide(companionSide);
}

export function chatCompanionSideFromDropPosition(clientX: number, left: number, width: number): CompanionSide {
  return clientX < left + (width / 2) ? 'left' : 'right';
}

export function clampChatSplitFraction(value: number) {
  return Math.min(0.68, Math.max(0.32, value));
}

export function collaborationModelDisplayName(modelValue?: string | null, modelOptions?: ComposerModelOption[]) {
  if (!modelValue?.trim()) return 'model default';
  const option = modelOptions?.find((candidate) => candidate.value === modelValue);
  return option?.label ?? modelValue;
}

export function collaborationThinkingDisplayName(value?: string | null) {
  if (!value?.trim() || value === 'default') return 'model default';
  return value[0]?.toUpperCase() + value.slice(1);
}

export function chatComposerSubmitMode(_input?: {
  isDesktopChatSending?: boolean;
  activeLiveTurnIsRunning?: boolean;
  hasDraft?: boolean;
  canSendWhileBusy?: boolean;
}) {
  // The composer is always in Send mode. Stopping a running turn happens via the
  // inline stop button on the agent message itself (see #267 / #273); keeping a
  // separate stop variant on the composer was redundant and prevented users from
  // queueing a follow-up message while a turn was in flight.
  return 'send' as const;
}

export function normalizeRoutingProviderId(providerId: string) {
  const normalized = providerId.trim().toLowerCase();
  return normalized === 'openai-codex' ? 'openai' : normalized;
}

export function authChoiceFromProviderOption(option: ComposerProviderOption) {
  return option.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;
}

export function firstModelForProvider(providerId: string, modelOptions?: ComposerModelOption[]) {
  const normalized = normalizeRoutingProviderId(providerId);
  return modelOptions?.find((option) => normalizeRoutingProviderId(option.provider ?? '') === normalized)?.value ?? null;
}

export function collaborationAuthDisplayName(authProvider?: string | null, authChoice?: string | null, providerOptions?: ComposerProviderOption[]) {
  if (!authProvider?.trim() && !authChoice?.trim()) return null;
  const option = providerOptions?.find((candidate) => (
    candidate.providerId === authProvider && authChoiceFromProviderOption(candidate) === (authChoice ?? null)
  ));
  if (option) return [option.label, option.detail].filter(Boolean).join(' · ');
  return authProvider ?? null;
}

export function collaborationRouteDisplayName(
  modelValue?: string | null,
  authProvider?: string | null,
  authChoice?: string | null,
  modelOptions?: ComposerModelOption[],
  providerOptions?: ComposerProviderOption[],
) {
  const model = collaborationModelDisplayName(modelValue, modelOptions);
  const auth = collaborationAuthDisplayName(authProvider, authChoice, providerOptions);
  return auth ? `${auth} · ${model}` : model;
}


import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, Dispatch, DragEvent, PointerEvent as ReactPointerEvent, RefObject, SetStateAction } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRightLeft,
  ChevronDown,
  Clock3,
  Cloud,
  Columns2,
  FileText,
  Globe,
  GripVertical,
  Image as ImageIcon,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Send,
  Shield,
  Split,
  X,
} from 'lucide-react';

import { AuthNoticeBanner } from '@/components/AuthNoticeBanner';
import {
  bridgeAgentRoutingChangeNotice,
  bridgeChatRoutingControlVisibility,
  localOwnedBridgeAgentsForModelRouting,
  routingSelectionForBridgeAgent,
} from '@/features/bridge/agentModelRouting';
import { isCloudBridgeHostId } from '@/features/cloud/cloudBridgeState';
import type { CloudSelfAgentSyncStatus } from '@/features/cloud/useCloudBridgeState';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatSessionIdSubtitle, localOwnedAgentSenderLabel, suppressLiveTurnEchoMessages } from '@/app/viewModels/helpers';
import {
  ComposerMentionMenu,
  ComposerModelControls,
  ComposerRuntimeStatus,
  ComposerSlashMenu,
  LiveChatTurnMessage,
  MessageBubble,
  TypeBadge,
  fallbackComposerThinkingValue,
  type ComposerAuthOption,
  type ComposerMentionOption,
  type ComposerModelOption,
  type ComposerProviderOption,
} from '@/kordi-app/components';
import type {
  Conversation,
  ConversationParticipant,
  DesktopBridgeHost,
  DesktopChatContextWindowStatus,
  DesktopChatSlashCommand,
  DesktopChatState,
  DesktopChatTurnSnapshot,
  EditFilePreview,
  Message,
  QueuedDesktopChatMessage,
} from '@/kordi-app/types';
import { useImeCompositionGuard } from '@/features/chat/imeComposition';
import { MessageBubbleShapeBackdrop, queuedMessageBubbleShapeClass } from '@/features/chat/messageBubbleShape';
import { chatComposerPlaceholder } from '@/features/chat/composerCopy';
import { extractClipboardFiles, extractPastedLocalFilePaths } from '@/features/chat/pasteAttachments';
import { buildReplyAttribution, shouldInferLatestHumanReplyTarget } from '@/features/chat/replyAttribution';
import {
  CHAT_COMPOSER_TEXTAREA_SELECTOR,
  focusComposerTextarea,
  focusComposerTextareaForNativeInput,
} from '@/features/chat/composerController.shared';
import { collapseAdjacentSessionConfigNotices } from '@/features/chat/sessionConfigNotices';
import { transcriptMessageRenderKey } from '@/features/chat/transcriptRenderKeys';
import { LOCAL_DRAFT_CHAT_CONVERSATION_ID } from '@/features/chat/draftSessions';
import { buildForkLineage } from '@/features/chat/forkLineage';
import { cn } from '@/lib/utils';

export const BRIDGE_ROUTING_NOTICE_AUTO_DISMISS_MS = 2000;
export const BRIDGE_ROUTING_NOTICE_EXIT_MS = 180;

export function shouldShowConversationTypeBadge(conversation: Pick<Conversation, 'id' | 'canonicalSessionId' | 'type' | 'forkedFromSessionId'>): boolean {
  const sessionId = (conversation.canonicalSessionId || conversation.id).trim();
  const forkParentId = conversation.forkedFromSessionId?.trim() ?? '';
  return !sessionId.startsWith('session:group:') && !forkParentId.startsWith('session:group:');
}

export function cloudSelfAgentSyncStatusLabel(status?: Pick<CloudSelfAgentSyncStatus, 'state' | 'pendingCount' | 'message'> | null) {
  if (!status) return null;
  if (status.state === 'syncing') {
    const pendingCount = typeof status.pendingCount === 'number' && Number.isFinite(status.pendingCount)
      ? Math.max(0, Math.floor(status.pendingCount))
      : 0;
    return pendingCount > 1 ? `Syncing ${pendingCount}` : 'Syncing';
  }
  if (status.state === 'synced') return 'Synced';
  return 'Sync issue';
}

function humanTranscriptGroupKey(message?: Message) {
  if (!message || message.role === 'system' || message.role === 'action' || message.role === 'edit' || message.turn) return null;
  const senderType = message.senderType ?? (message.role === 'user' || message.role === 'person' ? 'human' : 'agent');
  const isOwnHuman = (message.isOwnMessage ?? message.role === 'user') && senderType === 'human';
  const isPeerHuman = !isOwnHuman && (senderType === 'human' || message.role === 'person');
  if (!isOwnHuman && !isPeerHuman) return null;

  const side = isOwnHuman ? 'own' : 'peer';
  const senderKey = message.senderAvatarSeed?.trim()
    || message.senderProfileImageUrl?.trim()
    || message.sender?.trim()
    || side;
  return `${side}:${senderKey}`;
}

function isGroupedWithAdjacentHumanMessage(messages: readonly Message[], index: number, offset: -1 | 1) {
  const currentKey = humanTranscriptGroupKey(messages[index]);
  return Boolean(currentKey && currentKey === humanTranscriptGroupKey(messages[index + offset]));
}

type QueuedMessageBubbleProps = {
  message: QueuedDesktopChatMessage;
  isCompressionActive: boolean;
};

function QueuedMessageBubble({ message, isCompressionActive }: QueuedMessageBubbleProps) {
  return (
    <div className="flex justify-end py-0.5">
      <div className={cn('app-queued-message max-w-[min(72%,34rem)] px-3 py-2 text-right', queuedMessageBubbleShapeClass)}>
        <MessageBubbleShapeBackdrop side="own" />
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0 flex-1 text-left">
            <div className="app-queued-message-label mb-0.5 inline-flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.07em]">
              <Clock3 className="h-2.5 w-2.5" />
              <span>{isCompressionActive ? 'Queued during compression' : 'Queued next'}</span>
            </div>
            <div className="app-queued-message-text whitespace-pre-wrap break-words text-[13px] leading-5">{message.text}</div>
          </div>
          <div className="app-queued-message-meta shrink-0 pb-0.5 text-[10px] leading-none">{message.time}</div>
        </div>
        {message.attachments.length > 0 ? (
          <div className="app-queued-message-meta mt-1 text-[10px] leading-none">
            {message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'} waiting
          </div>
        ) : null}
      </div>
    </div>
  );
}

type Attachment = {
  id: string;
  name: string;
  path: string;
  kind: 'image' | 'file';
};

type CompanionSide = 'left' | 'right';

const CHAT_COMPANION_DRAG_TYPE = 'application/x-kordi-chat-companion';

function cleanKey(value?: string | null) {
  return value?.trim().toLowerCase() ?? '';
}

function participantIsSelf(participant: ConversationParticipant) {
  return participant.role === 'self' || (participant.source === 'local' && participant.kind === 'human');
}

function conversationIsHumanChat(conversation: Conversation) {
  return conversation.type === 'person'
    || conversation.canonicalParticipants?.some((participant) => !participantIsSelf(participant) && participant.kind === 'human') === true;
}

function conversationIsAgentChat(conversation: Conversation) {
  return conversation.type === 'owned-agent' || conversation.type === 'external-agent';
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
  const hostScope = cleanKey(conversation.bridgeTarget?.hostId) || cleanKey(conversation.identity?.bridgeHostId) || 'local';

  addPersonRelationshipKey(keys, hostScope, conversation.bridgeTarget?.humanId);
  addScopedKey(keys, `${hostScope}:node`, conversation.bridgeTarget?.nodeId);
  addScopedKey(keys, `${hostScope}:owner`, conversation.bridgeTarget?.ownerName);
  addPersonRelationshipKey(keys, hostScope, conversation.identity?.remoteHumanId);
  addScopedKey(keys, `${hostScope}:node`, conversation.identity?.remoteHumanNodeId);

  for (const participant of conversation.canonicalParticipants ?? []) {
    if (participantIsSelf(participant)) continue;
    addPersonRelationshipKey(keys, hostScope, participant.id);
    addPersonRelationshipKey(keys, hostScope, participant.humanId);
    addPersonRelationshipKey(keys, hostScope, participant.ownerIdentityId);
    addScopedKey(keys, `${hostScope}:node`, participant.bridgeNodeId);

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

export function chatCompanionCandidates(activeConv: Conversation, conversations: Conversation[]) {
  const wantsAgent = conversationIsHumanChat(activeConv);
  const wantsHuman = conversationIsAgentChat(activeConv);
  if (!wantsAgent && !wantsHuman) return [];

  return conversations.filter((conversation) => (
    conversation.id !== activeConv.id
    && (wantsAgent ? conversationIsAgentChat(conversation) : conversationIsHumanChat(conversation))
  ));
}

function companionLabel(conversation: Conversation) {
  return conversationIsHumanChat(conversation) ? 'Human chat' : 'Agent chat';
}

function conversationPaneKind(conversation: Conversation): 'human' | 'agent' | null {
  if (conversationIsHumanChat(conversation)) return 'human';
  if (conversationIsAgentChat(conversation)) return 'agent';
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

export function humanSideFromCompanionDrop(
  companionKind: 'human' | 'agent' | null,
  droppedSide: CompanionSide,
): CompanionSide {
  return companionKind === 'human' ? droppedSide : oppositeCompanionSide(droppedSide);
}

export function chatCompanionSideFromDropPosition(clientX: number, left: number, width: number): CompanionSide {
  return clientX < left + (width / 2) ? 'left' : 'right';
}

function clampChatSplitFraction(value: number) {
  return Math.min(0.68, Math.max(0.32, value));
}

function bridgeModelDisplayName(modelValue?: string | null, modelOptions?: ComposerModelOption[]) {
  if (!modelValue?.trim()) return 'model default';
  const option = modelOptions?.find((candidate) => candidate.value === modelValue);
  return option?.label ?? modelValue;
}

function bridgeThinkingDisplayName(value?: string | null) {
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

function normalizeRoutingProviderId(providerId: string) {
  const normalized = providerId.trim().toLowerCase();
  return normalized === 'openai-codex' ? 'openai' : normalized;
}

function authChoiceFromProviderOption(option: ComposerProviderOption) {
  return option.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;
}

function firstModelForProvider(providerId: string, modelOptions?: ComposerModelOption[]) {
  const normalized = normalizeRoutingProviderId(providerId);
  return modelOptions?.find((option) => normalizeRoutingProviderId(option.provider ?? '') === normalized)?.value ?? null;
}

function bridgeAuthDisplayName(authProvider?: string | null, authChoice?: string | null, providerOptions?: ComposerProviderOption[]) {
  if (!authProvider?.trim() && !authChoice?.trim()) return null;
  const option = providerOptions?.find((candidate) => (
    candidate.providerId === authProvider && authChoiceFromProviderOption(candidate) === (authChoice ?? null)
  ));
  if (option) return [option.label, option.detail].filter(Boolean).join(' · ');
  return authProvider ?? null;
}

function bridgeRouteDisplayName(
  modelValue?: string | null,
  authProvider?: string | null,
  authChoice?: string | null,
  modelOptions?: ComposerModelOption[],
  providerOptions?: ComposerProviderOption[],
) {
  const model = bridgeModelDisplayName(modelValue, modelOptions);
  const auth = bridgeAuthDisplayName(authProvider, authChoice, providerOptions);
  return auth ? `${auth} · ${model}` : model;
}

type ChatsPageProps = {
  isNativeShell: boolean;
  showChatDetailRail: boolean;
  collapseChatSessions: boolean;
  setIsSessionPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  showRightDetailRail: boolean;
  isDetailPanelCollapsed: boolean;
  setIsDetailPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  activeConv: Conversation;
  chatConversations: Conversation[];
  activeConversationIsBridge: boolean;
  activeBridgeModelHost: DesktopBridgeHost | null;
  desktopChatState: DesktopChatState | null;
  cloudSelfAgentSyncStatus?: CloudSelfAgentSyncStatus | null;
  onUpdateBridgeAgentModelRouting: (
    hostId: string,
    agentId: string,
    defaultModel?: string | null,
    fallbackModel?: string | null,
    thinking?: string | null,
    defaultAuthProvider?: string | null,
    defaultAuthChoice?: string | null,
    fallbackAuthProvider?: string | null,
    fallbackAuthChoice?: string | null,
  ) => Promise<void>;
  isEditingDesktopSessionTitle: boolean;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  desktopSessionRenameDraft: string;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  onRenameDesktopSession: (baselineName: string) => Promise<void>;
  chatTranscriptScrollRef: RefObject<HTMLDivElement | null>;
  onTranscriptScroll: () => void;
  onOpenSource: (file: EditFilePreview) => void;
  onOpenArtifact: (artifactId: string) => void;
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
  queuedDesktopMessages: QueuedDesktopChatMessage[];
  filteredChatSlashCommands: DesktopChatSlashCommand[];
  filteredChatMentionTargets: ComposerMentionOption[];
  chatSlashMenuIndex: number;
  setChatSlashMenuIndex: Dispatch<SetStateAction<number>>;
  acceptChatSlashCommand: (value: string) => void;
  acceptChatMentionTarget: (value: string) => void;
  chatAttachmentInputRef: RefObject<HTMLInputElement | null>;
  chatComposerAttachments: Attachment[];
  saveDesktopAttachments: (files: File[]) => Promise<Attachment[]>;
  saveDesktopAttachmentPaths: (paths: string[]) => Promise<Attachment[]>;
  removeChatComposerAttachment: (id: string) => void;
  chatComposerText: string;
  updateChatComposerDraft: (value: string, target: HTMLTextAreaElement) => void;
  setChatComposerText: (value: string) => void;
  setChatComposerTextForSession: (sessionId: string, value: string) => void;
  composerControlsRef: RefObject<HTMLDivElement | null>;
  activeRuntimeContextStatus?: DesktopChatContextWindowStatus | null;
  activeRuntimeCacheText?: string | null;
  composerSelection: { mode: string; model: string; thinking: string };
  openComposerSelector: { scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null;
  toggleComposerSelector: (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking') => void;
  selectComposerValue: (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string) => void;
  composerAuthLabel: string;
  composerAuthOptions: ComposerAuthOption[];
  selectComposerAuthChoice: (scope: 'chat' | 'project', providerId: string, choice: string) => void;
  selectComposerProviderChoice: (scope: 'chat' | 'project', option: ComposerProviderOption) => void;
  composerProviderOptions: ComposerProviderOption[];
  chatModelOptions?: ComposerModelOption[];
  isDesktopChatSending: boolean;
  onStopDesktopChatTurn: () => void;
  onStopBridgeAgentRequest: NonNullable<ComponentProps<typeof MessageBubble>['onStopBridgeAgentRequest']>;
  onRequestBridgeContact?: ComponentProps<typeof MessageBubble>['onRequestBridgeContact'];
  onForkChatMessage?: (sessionId: string, messageEntryId: string) => Promise<void>;
  onSelectSession?: (sessionId: string) => void;
  onSendChatMessage: (draftOverride?: string, targetSessionId?: string) => void;
  hasAnyAuth: boolean;
  onOpenAuthSettings: () => void;
  onOpenAccountAuthentication?: () => void;
};

export function ChatsPage({
  isNativeShell,
  showChatDetailRail,
  collapseChatSessions,
  setIsSessionPanelCollapsed,
  showRightDetailRail,
  isDetailPanelCollapsed,
  setIsDetailPanelCollapsed,
  activeConv,
  chatConversations,
  activeConversationIsBridge,
  activeBridgeModelHost,
  desktopChatState,
  cloudSelfAgentSyncStatus,
  onUpdateBridgeAgentModelRouting,
  isEditingDesktopSessionTitle,
  setIsEditingDesktopSessionTitle,
  desktopSessionRenameDraft,
  setDesktopSessionRenameDraft,
  onRenameDesktopSession,
  chatTranscriptScrollRef,
  onTranscriptScroll,
  onOpenSource,
  onOpenArtifact,
  desktopLiveTurn,
  queuedDesktopMessages,
  filteredChatSlashCommands,
  filteredChatMentionTargets,
  chatSlashMenuIndex,
  setChatSlashMenuIndex,
  acceptChatSlashCommand,
  acceptChatMentionTarget,
  chatAttachmentInputRef,
  chatComposerAttachments,
  saveDesktopAttachments,
  saveDesktopAttachmentPaths,
  removeChatComposerAttachment,
  chatComposerText,
  updateChatComposerDraft,
  setChatComposerText,
  setChatComposerTextForSession,
  composerControlsRef,
  activeRuntimeContextStatus,
  activeRuntimeCacheText,
  composerSelection,
  openComposerSelector,
  toggleComposerSelector,
  selectComposerValue,
  composerAuthLabel,
  composerAuthOptions,
  selectComposerAuthChoice,
  selectComposerProviderChoice,
  composerProviderOptions,
  chatModelOptions,
  isDesktopChatSending,
  onStopDesktopChatTurn,
  onStopBridgeAgentRequest,
  onRequestBridgeContact,
  onForkChatMessage,
  onSelectSession,
  onSendChatMessage,
  hasAnyAuth,
  onOpenAuthSettings,
  onOpenAccountAuthentication,
}: ChatsPageProps) {
  const openAuthentication = onOpenAccountAuthentication ?? onOpenAuthSettings;
  const authNoticeDescription = onOpenAccountAuthentication
    ? 'Connect a provider, save an API key, or choose a local LM Studio/Ollama server before starting AI chats.'
    : 'Connect a cloud provider, save an API key, or choose a local LM Studio/Ollama server in Authentication before starting AI chats.';
  const authNoticeActionLabel = 'Open authentication';
  const visibleDesktopLiveTurn = desktopLiveTurn ?? (!isNativeShell ? activeConv.previewLiveTurn ?? null : null);
  const isCompressionActive = visibleDesktopLiveTurn?.status === 'compacting';
  const activeLiveTurnIsRunning = Boolean(
    desktopLiveTurn && desktopLiveTurn.sessionId === activeConv.id && !desktopLiveTurn.completed,
  );
  const composerHasDraft = chatComposerText.trim().length > 0 || chatComposerAttachments.length > 0;
  const activeConvHasBridgeTransport = activeConv.bridges.some((bridge) => bridge.trim().toLowerCase() !== 'local');
  const activeSessionSubtitle = formatSessionIdSubtitle(activeConv.subtitle);
  const activeCloudSelfAgentSyncLabel = cloudSelfAgentSyncStatusLabel(cloudSelfAgentSyncStatus);
  const activeTranscriptLiveTurn = visibleDesktopLiveTurn?.sessionId === activeConv.id ? visibleDesktopLiveTurn : undefined;
  const chatComposerPlaceholderText = chatComposerPlaceholder(activeConv);
  const liveTurnSender = localOwnedAgentSenderLabel(activeConv);
  const [selectedBridgeAgentId, setSelectedBridgeAgentId] = useState<string | null>(null);
  const [bridgeRoutingNotice, setBridgeRoutingNotice] = useState<string | null>(null);
  const [humanPaneSide, setHumanPaneSide] = useState<CompanionSide>('left');
  const [selectedCompanionConversationId, setSelectedCompanionConversationId] = useState<string | null>(null);
  const [companionDrafts, setCompanionDrafts] = useState<Record<string, string>>({});
  const [companionDropPreviewSide, setCompanionDropPreviewSide] = useState<CompanionSide | null>(null);
  const [isDraggingCompanion, setIsDraggingCompanion] = useState(false);
  const [isCompanionFolded, setIsCompanionFolded] = useState(false);
  const [splitLeftFraction, setSplitLeftFraction] = useState(0.5);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const chatImeCompositionGuard = useImeCompositionGuard();
  // Forking is supported for local sessions and canonical group /
  // bridge sessions (the backend snapshots canonical messages into a
  // fresh local fork so the user can continue privately). The local
  // draft and ephemeral bridge transports are still excluded because
  // they have no persistent backing to read from.
  const activeConversationIsForkable = Boolean(
    onForkChatMessage
      && activeConv.id
      && activeConv.id !== LOCAL_DRAFT_CHAT_CONVERSATION_ID
      && !activeConv.id.startsWith('bridge:'),
  );
  const handleForkMessage = activeConversationIsForkable && onForkChatMessage
    ? (entryId: string) => {
        void onForkChatMessage(activeConv.id, entryId);
      }
    : undefined;
  const companionCandidates = useMemo(
    () => chatCompanionCandidates(activeConv, chatConversations),
    [activeConv, chatConversations],
  );
  const suggestedCompanionConversation = useMemo(
    () => pairedCompanionConversation(activeConv, companionCandidates) ?? companionCandidates[0] ?? null,
    [activeConv, companionCandidates],
  );
  const companionConversation = companionCandidates.find((conversation) => conversation.id === selectedCompanionConversationId)
    ?? suggestedCompanionConversation;
  const showCompanionPane = Boolean(companionConversation && !isCompanionFolded);
  const companionDraftText = companionConversation ? companionDrafts[companionConversation.id] ?? '' : '';
  const activePaneKind = conversationPaneKind(activeConv);
  const companionPaneKind = companionConversation ? conversationPaneKind(companionConversation) : null;
  const companionSide = chatCompanionSideForPaneKinds(activePaneKind, humanPaneSide);

  useEffect(() => {
    setIsCompanionFolded(false);
  }, [activeConv.id]);

  useEffect(() => {
    if (!selectedCompanionConversationId) return;
    if (!companionCandidates.some((conversation) => conversation.id === selectedCompanionConversationId)) {
      setSelectedCompanionConversationId(null);
    }
  }, [companionCandidates, selectedCompanionConversationId]);

  // If the active session is itself a fork, show a backlink at the top
  // of the transcript so the user can navigate to the source session.
  const activeForkSourceSessionId = activeConv.forkedFromSessionId?.trim() || null;
  const activeForkSourceMessageId = activeConv.forkedFromMessageId?.trim() || null;
  const activeForkSourceTitle = useMemo(() => {
    if (!activeForkSourceSessionId) return null;
    const summary = desktopChatState?.sessions.find((session) => session.id === activeForkSourceSessionId);
    return summary?.title || 'previous session';
  }, [activeForkSourceSessionId, desktopChatState?.sessions]);

  // Build a per-message lookup of forks anchored at each entry id of
  // the active session, so the transcript can render a "N forks" chip
  // and a popover listing them next to the message they branched from.
  const messageForksByEntryId = useMemo(() => {
    const summaries = desktopChatState?.sessions ?? [];
    const lineage = buildForkLineage(
      summaries.map((summary) => ({
        id: summary.id,
        forkedFromSessionId: summary.forkedFromSessionId ?? null,
        forkedFromMessageId: summary.forkedFromMessageId ?? null,
      })),
    );
    const forksAtMessage = lineage.forksByParentMessageIdBySession.get(activeConv.id);
    if (!forksAtMessage) return new Map<string, Array<{ sessionId: string; title: string; updatedAtLabel?: string }>>();
    const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
    const result = new Map<string, Array<{ sessionId: string; title: string; updatedAtLabel?: string }>>();
    for (const [messageId, forks] of forksAtMessage) {
      const entries = forks
        .map((fork) => summaryById.get(fork.id))
        .filter((summary): summary is NonNullable<typeof summary> => Boolean(summary))
        .map((summary) => ({
          sessionId: summary.id,
          title: summary.title || 'Untitled fork',
          updatedAtLabel: summary.updatedAtLabel,
        }));
      if (entries.length > 0) result.set(messageId, entries);
    }
    return result;
  }, [activeConv.id, desktopChatState?.sessions]);
  const [optimisticBridgeAgentRouting, setOptimisticBridgeAgentRouting] = useState<Record<string, {
    defaultModel?: string | null;
    defaultAuthProvider?: string | null;
    defaultAuthChoice?: string | null;
    fallbackModel?: string | null;
    fallbackAuthProvider?: string | null;
    fallbackAuthChoice?: string | null;
    thinking?: string | null;
  }>>({});
  const bridgeRoutingAgents = useMemo(
    () => localOwnedBridgeAgentsForModelRouting(activeBridgeModelHost ? [activeBridgeModelHost] : [], desktopChatState),
    [activeBridgeModelHost, desktopChatState],
  );
  const selectedBridgeRoutingAgentBase = bridgeRoutingAgents.find((agent) => agent.id === selectedBridgeAgentId)
    ?? bridgeRoutingAgents.find((agent) => agent.isActive)
    ?? bridgeRoutingAgents.find((agent) => agent.isDefault)
    ?? bridgeRoutingAgents[0]
    ?? null;
  const selectedBridgeRoutingKey = selectedBridgeRoutingAgentBase
    ? isCloudBridgeHostId(selectedBridgeRoutingAgentBase.hostId)
      ? `${selectedBridgeRoutingAgentBase.hostId}:${activeConv.canonicalSessionId ?? activeConv.id}:${selectedBridgeRoutingAgentBase.id}`
      : `${selectedBridgeRoutingAgentBase.hostId}:${selectedBridgeRoutingAgentBase.id}`
    : null;
  const selectedBridgeRoutingAgent = selectedBridgeRoutingAgentBase
    ? {
      ...selectedBridgeRoutingAgentBase,
      ...(selectedBridgeRoutingKey ? optimisticBridgeAgentRouting[selectedBridgeRoutingKey] : null),
    }
    : null;
  const bridgeRoutingSelection = routingSelectionForBridgeAgent(selectedBridgeRoutingAgent);
  const bridgeRoutingControlVisibility = bridgeChatRoutingControlVisibility(bridgeRoutingAgents.length);
  const bridgeAgentSelectorOpen = openComposerSelector?.scope === 'chat' && openComposerSelector.type === 'mode';
  const transcriptMessages = collapseAdjacentSessionConfigNotices(
    suppressLiveTurnEchoMessages(activeConv.messages, activeTranscriptLiveTurn),
  );
  const inferLatestHumanReplyTarget = shouldInferLatestHumanReplyTarget(activeConv);
  const attributedTranscript = useMemo(
    () => buildReplyAttribution(transcriptMessages, activeTranscriptLiveTurn, {
      inferLatestHumanRequest: inferLatestHumanReplyTarget,
    }),
    [activeTranscriptLiveTurn, inferLatestHumanReplyTarget, transcriptMessages],
  );
  const attributedTranscriptMessages = attributedTranscript.messages;
  // Index of the last message that came from the fork's snapshot
  // (everything inherited from the source up through the anchor). The
  // divider goes after this message so any continuation the user
  // sends in the fork shows up below it.
  const forkSnapshotBoundaryIndex = useMemo(() => {
    if (!activeForkSourceSessionId) return -1;
    let lastSnapshotIdx = -1;
    for (let index = 0; index < attributedTranscriptMessages.length; index += 1) {
      const message = attributedTranscriptMessages[index];
      const isAnchor = activeForkSourceMessageId
        && message.entryId === activeForkSourceMessageId;
      if (message.isForkSnapshot || isAnchor) {
        lastSnapshotIdx = index;
      }
    }
    return lastSnapshotIdx;
  }, [activeForkSourceSessionId, activeForkSourceMessageId, attributedTranscriptMessages]);
  const attributedActiveTranscriptLiveTurn = attributedTranscript.liveTurn ?? activeTranscriptLiveTurn;
  const shouldRenderLiveTurn = Boolean(attributedActiveTranscriptLiveTurn && !attributedActiveTranscriptLiveTurn.completed);
  const companionTranscriptMessages = useMemo(() => {
    if (!companionConversation) return [];
    const messages = collapseAdjacentSessionConfigNotices(companionConversation.messages);
    return buildReplyAttribution(messages, undefined, {
      inferLatestHumanRequest: shouldInferLatestHumanReplyTarget(companionConversation),
    }).messages;
  }, [companionConversation]);
  const updateCompanionDropPreview = (event: DragEvent<HTMLElement>) => {
    if (!companionConversation || isCompanionFolded) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const side = chatCompanionSideFromDropPosition(event.clientX, rect.left, rect.width);
    setCompanionDropPreviewSide(side);
    return side;
  };
  const handleCompanionDragStart = (event: DragEvent<HTMLElement>) => {
    if (!companionConversation) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(CHAT_COMPANION_DRAG_TYPE, companionConversation.id);
    setIsDraggingCompanion(true);
    setCompanionDropPreviewSide(companionSide);
  };
  const handleCompanionDragEnd = () => {
    setIsDraggingCompanion(false);
    setCompanionDropPreviewSide(null);
  };
  const handleCompanionDragOver = (event: DragEvent<HTMLElement>) => {
    if (!isDraggingCompanion) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    updateCompanionDropPreview(event);
  };
  const handleCompanionDrop = (event: DragEvent<HTMLElement>) => {
    if (!isDraggingCompanion) return;
    event.preventDefault();
    const side = updateCompanionDropPreview(event);
    if (side) setHumanPaneSide(humanSideFromCompanionDrop(companionPaneKind, side));
    setIsDraggingCompanion(false);
    setCompanionDropPreviewSide(null);
  };
  const updateCompanionDraft = (conversationId: string, value: string, target: HTMLTextAreaElement) => {
    setCompanionDrafts((current) => ({
      ...current,
      [conversationId]: value,
    }));
    setChatComposerTextForSession(conversationId, value);
    target.style.height = '0px';
    target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
  };
  const sendCompanionDraft = (conversation: Conversation) => {
    const draft = companionDrafts[conversation.id] ?? '';
    if (!draft.trim()) return;
    onSendChatMessage(draft, conversation.id);
    setCompanionDrafts((current) => {
      const next = { ...current };
      delete next[conversation.id];
      return next;
    });
  };
  const moveCompanionToSide = (side: CompanionSide) => {
    setHumanPaneSide(humanSideFromCompanionDrop(companionPaneKind, side));
  };
  const updateSplitFromPointer = (clientX: number) => {
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    setSplitLeftFraction(clampChatSplitFraction((clientX - rect.left) / rect.width));
  };
  const handleSplitDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateSplitFromPointer(event.clientX);
  };
  const handleSplitDividerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    updateSplitFromPointer(event.clientX);
  };
  const handleSplitDividerPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const companionPane = companionConversation ? (
    <aside className="app-chat-companion-pane flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-white/[0.06] bg-white/[0.025] data-[side=left]:border-r data-[side=right]:border-l" data-side={companionSide}>
      <div
        className="app-page-header flex min-h-[112px] shrink-0 cursor-grab items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3 active:cursor-grabbing"
        draggable
        onDragStart={handleCompanionDragStart}
        onDragEnd={handleCompanionDragEnd}
        title={`Drag to move ${companionLabel(companionConversation)} left or right`}
      >
        <div className="flex min-w-0 items-start gap-2">
          <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex min-w-0 flex-wrap items-start gap-1.5 text-white">
              <span className="min-w-[10rem] flex-1 break-words text-[17px] font-semibold leading-6">{companionConversation.name}</span>
              {shouldShowConversationTypeBadge(companionConversation) ? <TypeBadge type={companionConversation.type} compact /> : null}
              <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-white/10 bg-white/[0.04] px-2 text-[10.5px] font-medium text-slate-300">
                {companionLabel(companionConversation)}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-5 text-slate-400">
              <span className="inline-flex items-center gap-1"><Shield className="h-3 w-3" /> {companionConversation.trust}</span>
              {companionConversation.bridges.map((bridge) => (
                <span key={bridge} className="inline-flex items-center gap-1"><Globe className="h-3 w-3" /> {bridge}</span>
              ))}
              <span className="inline-flex items-center gap-1"><ArrowRightLeft className="h-3 w-3" /> {companionConversation.directness}</span>
            </div>
          </div>
        </div>
        <div
          className="flex shrink-0 items-center gap-2"
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {companionCandidates.length > 1 ? (
            <select
              value={companionConversation.id}
              onChange={(event) => setSelectedCompanionConversationId(event.target.value)}
              className="h-7 max-w-[11rem] rounded-full border border-white/10 bg-white/[0.04] px-2.5 text-[11px] text-slate-100 outline-none transition hover:bg-white/[0.08] focus:border-white/20"
              title={`Choose ${companionLabel(companionConversation)}`}
              aria-label={`Choose ${companionLabel(companionConversation)}`}
            >
              {companionCandidates.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>
      <ScrollArea className="h-full min-h-0 px-3 py-5">
        <div className="space-y-1">
          {companionTranscriptMessages.length > 0 ? companionTranscriptMessages.map((msg, idx) => (
            <MessageBubble
              key={transcriptMessageRenderKey(msg, idx)}
              msg={msg}
              onOpenSource={onOpenSource}
              onOpenArtifact={onOpenArtifact}
              onOpenAuthSettings={openAuthentication}
              onStopBridgeAgentRequest={onStopBridgeAgentRequest}
              onRequestBridgeContact={onRequestBridgeContact}
              onForkMessage={onForkChatMessage ? (entryId) => {
                void onForkChatMessage(companionConversation.id, entryId);
              } : undefined}
              onOpenForkSession={onSelectSession}
              isGroupedWithPrevious={isGroupedWithAdjacentHumanMessage(companionTranscriptMessages, idx, -1)}
              isGroupedWithNext={isGroupedWithAdjacentHumanMessage(companionTranscriptMessages, idx, 1)}
            />
          )) : (
            <div className="flex h-full min-h-[12rem] items-center justify-center px-4 text-center text-[12px] text-slate-500">
              No messages in this side chat yet.
            </div>
          )}
        </div>
      </ScrollArea>
      <div className="shrink-0 border-t border-white/[0.06] px-5 pb-4 pt-3">
        <div className="app-composer-shell rounded-[26px] p-3">
          <div className="app-composer-input flex items-end gap-2 rounded-[18px] px-4 py-2.5">
            <textarea
              rows={1}
              value={companionDraftText}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => updateCompanionDraft(companionConversation.id, event.target.value, event.target)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                  event.preventDefault();
                  sendCompanionDraft(companionConversation);
                }
              }}
              className="min-h-[24px] max-h-[220px] flex-1 resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
              placeholder={`Draft for ${companionConversation.name}`}
              data-composer-scope="companion"
            />
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={() => sendCompanionDraft(companionConversation)}
              className="app-composer-send h-10 w-10 shrink-0 rounded-full p-0"
              title={`Send to ${companionConversation.name}`}
              aria-label={`Send to ${companionConversation.name}`}
              disabled={!companionDraftText.trim()}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </aside>
  ) : null;
  const splitDivider = showCompanionPane && companionConversation ? (
    <div
      className="app-chat-split-divider group relative z-10 flex h-full w-2.5 cursor-col-resize touch-none items-center justify-center border-x border-white/[0.06] bg-white/[0.025] transition hover:bg-white/[0.05]"
      data-split-layout-divider="true"
      onPointerDown={handleSplitDividerPointerDown}
      onPointerMove={handleSplitDividerPointerMove}
      onPointerUp={handleSplitDividerPointerUp}
      onPointerCancel={handleSplitDividerPointerUp}
      title="Drag to resize chats"
      aria-label="Resize side-by-side chats"
      role="separator"
      aria-orientation="vertical"
    >
      <div className="flex flex-col items-center gap-1 rounded-full border border-white/[0.08] bg-black/20 p-1 opacity-80 shadow-[0_12px_28px_rgba(0,0,0,0.22)] backdrop-blur-xl transition group-hover:opacity-100">
        <GripVertical className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <Button
          type="button"
          size="icon"
          variant="secondary"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setIsCompanionFolded(true);
          }}
          className="app-icon-button app-utility-button h-7 w-7 rounded-full p-0 text-slate-100 transition"
          aria-label={`Hide ${companionLabel(companionConversation)}`}
          title={`Hide ${companionConversation.name}`}
        >
          <Columns2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="secondary"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            moveCompanionToSide(oppositeCompanionSide(companionSide));
          }}
          className="app-icon-button app-utility-button h-7 w-7 rounded-full p-0 text-slate-100 transition"
          aria-label={`Swap ${companionLabel(companionConversation)} to the ${companionSide === 'right' ? 'left' : 'right'}`}
          title={`Swap ${companionConversation.name} to the ${companionSide === 'right' ? 'left' : 'right'}`}
        >
          <ArrowRightLeft className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  ) : null;

  useEffect(() => {
    if (!bridgeRoutingNotice) return;
    const timeoutId = window.setTimeout(() => {
      setBridgeRoutingNotice(null);
    }, BRIDGE_ROUTING_NOTICE_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [bridgeRoutingNotice]);

  const closeBridgeRoutingSelector = (type: 'provider' | 'model' | 'thinking') => {
    if (openComposerSelector?.scope === 'chat' && openComposerSelector.type === type) {
      toggleComposerSelector('chat', type);
    }
  };

  const defaultThinkingForBridgeModel = (modelValue: string | null | undefined, currentThinking: string | null | undefined) => {
    const thinkingLevels = chatModelOptions?.find((option) => option.value === modelValue)?.thinkingLevels ?? [];
    return fallbackComposerThinkingValue(thinkingLevels, currentThinking ?? 'default');
  };

  const updateBridgeAgentRouting = ({
    defaultModel,
    defaultAuthProvider,
    defaultAuthChoice,
    fallbackModel,
    fallbackAuthProvider,
    fallbackAuthChoice,
    thinking,
    selectorType,
  }: {
    defaultModel?: string | null;
    defaultAuthProvider?: string | null;
    defaultAuthChoice?: string | null;
    fallbackModel?: string | null;
    fallbackAuthProvider?: string | null;
    fallbackAuthChoice?: string | null;
    thinking?: string | null;
    selectorType?: 'provider' | 'model' | 'thinking';
  }) => {
    if (selectorType) closeBridgeRoutingSelector(selectorType);
    focusComposerTextarea(CHAT_COMPOSER_TEXTAREA_SELECTOR);
    if (!selectedBridgeRoutingAgent || !selectedBridgeRoutingKey) return;
    if (isDesktopChatSending || activeLiveTurnIsRunning) {
      setBridgeRoutingNotice("Stop the running task before changing this session's model or thinking level.");
      return;
    }

    const currentModel = selectedBridgeRoutingAgent.defaultModel ?? null;
    const currentDefaultAuthProvider = selectedBridgeRoutingAgent.defaultAuthProvider ?? null;
    const currentDefaultAuthChoice = selectedBridgeRoutingAgent.defaultAuthChoice ?? null;
    const currentFallback = selectedBridgeRoutingAgent.fallbackModel ?? null;
    const currentFallbackAuthProvider = selectedBridgeRoutingAgent.fallbackAuthProvider ?? null;
    const currentFallbackAuthChoice = selectedBridgeRoutingAgent.fallbackAuthChoice ?? null;
    const currentThinking = selectedBridgeRoutingAgent.thinking ?? null;
    const nextModel = defaultModel !== undefined ? defaultModel : currentModel;
    const nextDefaultAuthProvider = defaultAuthProvider !== undefined ? defaultAuthProvider : currentDefaultAuthProvider;
    const nextDefaultAuthChoice = defaultAuthChoice !== undefined ? defaultAuthChoice : currentDefaultAuthChoice;
    const nextFallback = fallbackModel !== undefined ? fallbackModel : currentFallback;
    const nextFallbackAuthProvider = fallbackAuthProvider !== undefined ? fallbackAuthProvider : currentFallbackAuthProvider;
    const nextFallbackAuthChoice = fallbackAuthChoice !== undefined ? fallbackAuthChoice : currentFallbackAuthChoice;
    const nextThinking = thinking !== undefined ? thinking : currentThinking;
    const defaultAuthChanged = (defaultAuthProvider !== undefined && nextDefaultAuthProvider !== currentDefaultAuthProvider)
      || (defaultAuthChoice !== undefined && nextDefaultAuthChoice !== currentDefaultAuthChoice);
    const fallbackAuthChanged = (fallbackAuthProvider !== undefined && nextFallbackAuthProvider !== currentFallbackAuthProvider)
      || (fallbackAuthChoice !== undefined && nextFallbackAuthChoice !== currentFallbackAuthChoice);
    const noticeText = bridgeAgentRoutingChangeNotice({
      agentLabel: selectedBridgeRoutingAgent.label,
      currentModel,
      nextModel: defaultModel,
      currentThinking,
      nextThinking: thinking,
      modelLabel: bridgeRouteDisplayName(nextModel, nextDefaultAuthProvider, nextDefaultAuthChoice, chatModelOptions, composerProviderOptions),
      thinkingLabel: bridgeThinkingDisplayName(nextThinking),
    }) ?? ((defaultAuthChanged || fallbackAuthChanged)
      ? `${selectedBridgeRoutingAgent.label} model route changed to ${bridgeRouteDisplayName(nextModel, nextDefaultAuthProvider, nextDefaultAuthChoice, chatModelOptions, composerProviderOptions)}. Only you can see this.`
      : null);
    if (!noticeText) return;

    setOptimisticBridgeAgentRouting((current) => ({
      ...current,
      [selectedBridgeRoutingKey]: {
        defaultModel: nextModel,
        defaultAuthProvider: nextDefaultAuthProvider,
        defaultAuthChoice: nextDefaultAuthChoice,
        fallbackModel: nextFallback,
        fallbackAuthProvider: nextFallbackAuthProvider,
        fallbackAuthChoice: nextFallbackAuthChoice,
        thinking: nextThinking,
      },
    }));
    setBridgeRoutingNotice(noticeText);
    void onUpdateBridgeAgentModelRouting(
      selectedBridgeRoutingAgent.hostId,
      selectedBridgeRoutingAgent.id,
      nextModel,
      nextFallback,
      nextThinking,
      nextDefaultAuthProvider,
      nextDefaultAuthChoice,
      nextFallbackAuthProvider,
      nextFallbackAuthChoice,
    ).catch((error) => {
      setBridgeRoutingNotice(error instanceof Error ? error.message : 'Unable to update bridge agent model routing');
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={splitContainerRef}
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden',
          showCompanionPane && 'grid',
          isDraggingCompanion && 'ring-1 ring-sky-300/25',
          companionDropPreviewSide === 'left' && 'bg-gradient-to-r from-sky-400/10 via-transparent to-transparent',
          companionDropPreviewSide === 'right' && 'bg-gradient-to-l from-sky-400/10 via-transparent to-transparent',
        )}
        style={showCompanionPane ? {
          gridTemplateColumns: `minmax(280px, ${splitLeftFraction}fr) 10px minmax(280px, ${1 - splitLeftFraction}fr)`,
        } : undefined}
        data-chat-companion-side={showCompanionPane ? companionSide : 'folded'}
        data-chat-companion-drop-preview={companionDropPreviewSide ?? undefined}
        onDragOver={handleCompanionDragOver}
        onDrop={handleCompanionDrop}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setCompanionDropPreviewSide(null);
          }
        }}
      >
        {showCompanionPane && companionSide === 'left' ? companionPane : null}
        {showCompanionPane && companionSide === 'left' ? splitDivider : null}
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white/[0.025]" data-active-side={companionSide === 'left' ? 'right' : 'left'}>
      <div className="app-page-header flex min-h-[112px] shrink-0 items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
        <div className="flex min-w-0 items-start gap-2">
          {showChatDetailRail && (
            <button
              type="button"
              onClick={() => setIsSessionPanelCollapsed((collapsed) => !collapsed)}
              className="app-icon-button app-utility-button grid h-7.5 w-7.5 shrink-0 place-items-center rounded-[12px] text-slate-100 transition"
              aria-label={collapseChatSessions ? 'Open sessions' : 'Close sessions'}
              title={collapseChatSessions ? 'Open sessions' : 'Close sessions'}
            >
              {collapseChatSessions ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="app-page-header-title-row mb-1 flex min-w-0 flex-wrap items-start gap-1.5 text-white">
              {isNativeShell ? (
                isEditingDesktopSessionTitle ? (
                  <input
                    value={desktopSessionRenameDraft}
                    onChange={(event) => setDesktopSessionRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setDesktopSessionRenameDraft(activeConv.name);
                        setIsEditingDesktopSessionTitle(false);
                      }
                    }}
                    onBlur={() => {
                      void onRenameDesktopSession(activeConv.name);
                    }}
                    autoFocus
                    data-kordi-window-drag="false"
                    className="min-w-[220px] max-w-full rounded-lg bg-transparent px-1 py-0.5 text-left text-[17px] font-semibold text-white outline-none ring-1 ring-white/10 placeholder:text-slate-500 focus:ring-white/20"
                    placeholder="Session name"
                  />
                ) : (
                  <h2
                    onDoubleClick={() => {
                      if (activeConversationIsBridge) return;
                      setDesktopSessionRenameDraft(activeConv.name);
                      setIsEditingDesktopSessionTitle(true);
                    }}
                    className="min-w-[12rem] max-w-full flex-1 break-words rounded-lg px-1 py-0.5 text-left text-[17px] font-semibold leading-6 text-white transition hover:bg-white/5"
                    data-kordi-window-drag="false"
                    title={activeConv.name}
                  >
                    {activeConv.name}
                  </h2>
                )
              ) : (
                <h2 className="min-w-[12rem] max-w-full flex-1 break-words text-[17px] font-semibold leading-6" data-kordi-window-drag="false">{activeConv.name}</h2>
              )}
              {activeCloudSelfAgentSyncLabel ? (
                <span
                  className={cn(
                    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors',
                    cloudSelfAgentSyncStatus?.state === 'error'
                      ? 'text-rose-300'
                      : cloudSelfAgentSyncStatus?.state === 'syncing'
                        ? 'text-sky-200'
                        : 'text-emerald-200',
                  )}
                  title={cloudSelfAgentSyncStatus?.state === 'error'
                    ? cloudSelfAgentSyncStatus.message || 'Cloud sync needs attention'
                    : activeCloudSelfAgentSyncLabel}
                  aria-label={cloudSelfAgentSyncStatus?.state === 'error'
                    ? 'Cloud sync issue'
                    : activeCloudSelfAgentSyncLabel}
                  data-cloud-self-agent-sync-status={cloudSelfAgentSyncStatus?.state ?? 'idle'}
                >
                  <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              ) : null}
              {shouldShowConversationTypeBadge(activeConv) ? <TypeBadge type={activeConv.type} compact /> : null}
              {activePaneKind ? (
                <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-white/10 bg-white/[0.04] px-2 text-[10.5px] font-medium text-slate-300">
                  {activePaneKind === 'human' ? 'Human chat' : 'Agent chat'}
                </span>
              ) : null}
              {activeForkSourceSessionId ? (
                <button
                  type="button"
                  onClick={() => onSelectSession?.(activeForkSourceSessionId)}
                  disabled={!onSelectSession}
                  className="app-fork-source-pill inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 text-[10.5px] font-medium text-slate-300 transition hover:bg-white/[0.08] hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  title={`Forked from "${activeForkSourceTitle}" — open the source session`}
                  data-kordi-window-drag="false"
                >
                  <Split className="h-2.5 w-2.5" />
                  <span className="max-w-[12rem] truncate">Forked from {activeForkSourceTitle}</span>
                </button>
              ) : null}
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-5 text-slate-400">
              {activeSessionSubtitle ? (
                <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono" title={activeSessionSubtitle}>
                  <span className="truncate">{activeSessionSubtitle}</span>
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1"><Shield className="h-3 w-3" /> {activeConv.trust}</span>
              {activeConv.bridges.map((bridge) => (
                <span key={bridge} className="inline-flex items-center gap-1"><Globe className="h-3 w-3" /> {bridge}</span>
              ))}
              <span className="inline-flex items-center gap-1"><ArrowRightLeft className="h-3 w-3" /> {activeConv.directness}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {companionConversation && isCompanionFolded ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsCompanionFolded(false)}
              className="app-icon-button app-utility-button mt-0.5 h-8 rounded-full px-3 text-[12px] text-slate-100 transition"
              aria-label={`Show ${companionLabel(companionConversation)}`}
              title={`Show ${companionConversation.name}`}
            >
              <Columns2 className="mr-1.5 h-3.5 w-3.5" />
              Show side
            </Button>
          ) : null}
          {showRightDetailRail && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsDetailPanelCollapsed((collapsed) => !collapsed)}
              className="app-icon-button app-utility-button mt-0.5 h-8 rounded-full px-3 text-[12px] text-slate-100 transition"
              aria-label={isDetailPanelCollapsed ? 'Open session details' : 'Hide session details'}
              title={isDetailPanelCollapsed ? 'Open session details' : 'Hide session details'}
            >
              {isDetailPanelCollapsed ? 'Details' : 'Hide details'}
            </Button>
          )}
        </div>
      </div>

      {!hasAnyAuth && !activeConversationIsBridge ? (
        <AuthNoticeBanner
          title="No provider connected yet"
          description={authNoticeDescription}
          actionLabel={authNoticeActionLabel}
          onAction={onOpenAccountAuthentication ?? onOpenAuthSettings}
        />
      ) : null}

        <ScrollArea
          ref={chatTranscriptScrollRef}
          className="min-h-0 flex-1 px-3.5 py-5 sm:px-4"
          onScroll={onTranscriptScroll}
        >
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-1">
            {attributedTranscriptMessages.map((msg, idx) => (
              <Fragment key={transcriptMessageRenderKey(msg, idx)}>
                <MessageBubble
                  msg={msg}
                  onOpenSource={onOpenSource}
                  onOpenArtifact={onOpenArtifact}
                  onOpenAuthSettings={openAuthentication}
                  onStopBridgeAgentRequest={onStopBridgeAgentRequest}
                  onRequestBridgeContact={onRequestBridgeContact}
                  onForkMessage={handleForkMessage}
                  messageForks={msg.entryId ? messageForksByEntryId.get(msg.entryId) : undefined}
                  onOpenForkSession={onSelectSession}
                  isGroupedWithPrevious={isGroupedWithAdjacentHumanMessage(attributedTranscriptMessages, idx, -1)}
                  isGroupedWithNext={isGroupedWithAdjacentHumanMessage(attributedTranscriptMessages, idx, 1)}
                />
                {idx === forkSnapshotBoundaryIndex && activeForkSourceSessionId ? (
                  <div className="my-2 flex items-center gap-3 px-2 text-[11px] font-medium uppercase tracking-[0.06em] text-sky-300">
                    <span className="h-px flex-1 bg-sky-500/30" aria-hidden="true" />
                    <button
                      type="button"
                      onClick={() => onSelectSession?.(activeForkSourceSessionId)}
                      disabled={!onSelectSession}
                      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-sky-300 transition hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-60"
                      title={`Open the source conversation${activeForkSourceTitle ? ` (${activeForkSourceTitle})` : ''}`}
                    >
                      <Split className="h-3 w-3" />
                      <span>Forked from conversation</span>
                    </button>
                    <span className="h-px flex-1 bg-sky-500/30" aria-hidden="true" />
                  </div>
                ) : null}
              </Fragment>
            ))}
            {shouldRenderLiveTurn && attributedActiveTranscriptLiveTurn ? (
              <LiveChatTurnMessage
                turn={attributedActiveTranscriptLiveTurn}
                sender={liveTurnSender}
                onStopBridgeAgentRequest={onStopBridgeAgentRequest}
                onStopActiveTurn={onStopDesktopChatTurn}
                onOpenArtifact={onOpenArtifact}
                onOpenAuthSettings={openAuthentication}
              />
            ) : null}
            {queuedDesktopMessages.map((message) => (
              <QueuedMessageBubble key={message.id} message={message} isCompressionActive={isCompressionActive} />
            ))}
          </motion.div>
        </ScrollArea>

      <div className="shrink-0 px-5 pb-4 pt-3">
        <AnimatePresence initial={false}>
          {activeConversationIsBridge && bridgeRoutingNotice ? (
            <motion.div
              key={bridgeRoutingNotice}
              className="mb-2 flex justify-center"
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: prefersReducedMotion ? 0 : -4 }}
              transition={{ duration: prefersReducedMotion ? 0.01 : BRIDGE_ROUTING_NOTICE_EXIT_MS / 1000, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="max-w-[min(100%,38rem)] truncate rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-center text-[11px] text-slate-300">
                Private · {bridgeRoutingNotice}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <div className="app-composer-shell rounded-[26px] p-3">
          <div className="relative">
            {filteredChatSlashCommands.length > 0 ? (
              <ComposerSlashMenu
                items={filteredChatSlashCommands}
                selectedIndex={Math.min(chatSlashMenuIndex, filteredChatSlashCommands.length - 1)}
                onSelect={acceptChatSlashCommand}
              />
            ) : filteredChatMentionTargets.length > 0 ? (
              <ComposerMentionMenu
                items={filteredChatMentionTargets}
                selectedIndex={Math.min(chatSlashMenuIndex, filteredChatMentionTargets.length - 1)}
                onSelect={acceptChatMentionTarget}
              />
            ) : null}
            <div
              className={cn(
                'app-composer-input rounded-[18px] transition',
                chatComposerAttachments.length > 0 ? 'px-3 pb-1.5 pt-1' : 'px-4 py-2.5',
              )}
            >
              <input
                ref={chatAttachmentInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length > 0) {
                    void saveDesktopAttachments(files);
                  }
                  event.currentTarget.value = '';
                }}
              />
              {chatComposerAttachments.length > 0 ? (
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {chatComposerAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-2.5 text-[11px] text-[color:var(--utility-foreground)]"
                    >
                      {attachment.kind === 'image' ? <ImageIcon className="h-3.5 w-3.5 shrink-0 text-sky-300" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
                      <span className="max-w-[220px] truncate leading-none">{attachment.name}</span>
                      <button
                        type="button"
                        onClick={() => removeChatComposerAttachment(attachment.id)}
                        className="text-[color:var(--utility-muted-text)] transition hover:text-[color:var(--utility-foreground)]"
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                rows={1}
                value={chatComposerText}
                onPointerDownCapture={() => focusComposerTextareaForNativeInput(CHAT_COMPOSER_TEXTAREA_SELECTOR, isNativeShell)}
                onFocus={() => focusComposerTextareaForNativeInput(CHAT_COMPOSER_TEXTAREA_SELECTOR, isNativeShell)}
                onChange={(event) => updateChatComposerDraft(event.target.value, event.target)}
                onPaste={(event) => {
                  const files = extractClipboardFiles(event.clipboardData);
                  if (files.length > 0) {
                    event.preventDefault();
                    void saveDesktopAttachments(files);
                    return;
                  }

                  const pastedPaths = extractPastedLocalFilePaths(
                    event.clipboardData.getData('text/plain'),
                    event.clipboardData.getData('text/uri-list'),
                  );
                  if (pastedPaths.length > 0) {
                    event.preventDefault();
                    void saveDesktopAttachmentPaths(pastedPaths);
                  }
                }}
                onCompositionStart={chatImeCompositionGuard.onCompositionStart}
                onCompositionEnd={chatImeCompositionGuard.onCompositionEnd}
                onKeyDown={(event) => {
                  if (chatImeCompositionGuard.isComposingKeyDown(event)) return;
                  if (filteredChatSlashCommands.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setChatSlashMenuIndex((current) => (current + 1) % filteredChatSlashCommands.length);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setChatSlashMenuIndex((current) => (current - 1 + filteredChatSlashCommands.length) % filteredChatSlashCommands.length);
                      return;
                    }
                    if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) || event.key === 'Tab') {
                      event.preventDefault();
                      acceptChatSlashCommand(filteredChatSlashCommands[Math.min(chatSlashMenuIndex, filteredChatSlashCommands.length - 1)]?.value ?? filteredChatSlashCommands[0].value);
                      return;
                    }
                  }
                  if (filteredChatMentionTargets.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      event.stopPropagation();
                      setChatSlashMenuIndex((current) => (current + 1) % filteredChatMentionTargets.length);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      event.stopPropagation();
                      setChatSlashMenuIndex((current) => (current - 1 + filteredChatMentionTargets.length) % filteredChatMentionTargets.length);
                      return;
                    }
                    if (((event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) || event.key === 'Tab') && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.stopPropagation();
                      acceptChatMentionTarget(filteredChatMentionTargets[Math.min(chatSlashMenuIndex, filteredChatMentionTargets.length - 1)]?.value ?? filteredChatMentionTargets[0].value);
                      return;
                    }
                  }
                  if (event.key === 'Escape' && filteredChatSlashCommands.length > 0) {
                    event.preventDefault();
                    setChatComposerText('/');
                    return;
                  }
                  if (event.key === 'Escape' && filteredChatMentionTargets.length > 0) {
                    event.preventDefault();
                    setChatComposerText(chatComposerText.replace(/(^|\s)@([^\s@]*)$/, '$1'));
                    return;
                  }
                  if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                    event.preventDefault();
                    onSendChatMessage(event.currentTarget.value);
                  }
                }}
                className="min-h-[24px] max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                data-composer-scope="chat"
                placeholder={chatComposerPlaceholderText}
              />
            </div>
          </div>
          <div ref={composerControlsRef} className="app-composer-meta mt-2 flex items-center justify-between gap-4 pt-2.5">
            <div className="flex shrink-0 items-center gap-2 overflow-visible pr-1">
              <Button
                size="icon"
                variant="secondary"
                className="app-icon-button h-9 w-9 shrink-0 rounded-full border-0"
                onClick={() => chatAttachmentInputRef.current?.click()}
                title="Add attachment"
                aria-label="Add attachment"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex min-w-0 shrink-0 items-center gap-3 overflow-visible">
              {!activeConversationIsBridge && (isNativeShell || activeRuntimeContextStatus) ? (
                <ComposerRuntimeStatus
                  contextStatus={activeRuntimeContextStatus}
                  cacheText={activeRuntimeCacheText}
                />
              ) : null}
              {!activeConversationIsBridge ? (
                <ComposerModelControls
                  scope="chat"
                  selection={composerSelection}
                  openSelector={openComposerSelector}
                  onToggleSelector={toggleComposerSelector}
                  onSelectValue={(scope, type, value) => {
                    void selectComposerValue(scope, type, value);
                  }}
                  authLabel={composerAuthLabel}
                  authOptions={composerAuthOptions}
                  onSelectAuthChoice={(scope, providerId, choice) => {
                    void selectComposerAuthChoice(scope, providerId, choice);
                  }}
                  onSelectProviderChoice={(scope, option) => {
                    void selectComposerProviderChoice(scope, option);
                  }}
                  providerOptions={composerProviderOptions}
                  modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
                />
              ) : selectedBridgeRoutingAgent ? (
                <div className="relative flex min-w-0 items-center gap-2">
                  {bridgeRoutingControlVisibility.showAgentSelector ? (
                    <button
                      type="button"
                      onClick={() => toggleComposerSelector('chat', 'mode')}
                      className="inline-flex max-w-[10rem] items-center gap-1.5 rounded-full px-1 py-0.5 text-[12px] font-medium text-slate-300 transition hover:text-white"
                      title="Choose which owned agent these private settings apply to"
                    >
                      <span className="truncate">{selectedBridgeRoutingAgent.label}</span>
                      <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', bridgeAgentSelectorOpen ? 'rotate-180 text-slate-300' : '')} />
                    </button>
                  ) : null}
                  {bridgeAgentSelectorOpen ? (
                    <div className="absolute bottom-full right-0 z-30 mb-2 max-h-[min(22rem,50vh)] w-[260px] overflow-y-auto rounded-[14px] border border-[color:var(--app-divider)] bg-[var(--app-modal-bg)] px-3 py-3 text-[12px] shadow-[var(--app-shadow-float)] backdrop-blur-xl">
                      <div className="pb-2 text-[12px] font-medium text-[color:var(--utility-foreground)]">My agent</div>
                      <div className="space-y-1">
                        {bridgeRoutingAgents.map((agent) => (
                          <button
                            key={`${agent.hostId}:${agent.id}`}
                            type="button"
                            onClick={() => {
                              setSelectedBridgeAgentId(agent.id);
                              toggleComposerSelector('chat', 'mode');
                            }}
                            className={cn(
                              'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                              selectedBridgeRoutingAgent.id === agent.id ? 'app-composer-popover-item-active' : '',
                            )}
                          >
                            <span className="truncate">{agent.label}</span>
                            <span className="shrink-0 text-[11px] text-[color:var(--utility-muted-text)]">{agent.isDefault ? 'Default' : 'Owned'}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <ComposerModelControls
                    scope="chat"
                    selection={bridgeRoutingSelection}
                    openSelector={openComposerSelector}
                    onToggleSelector={toggleComposerSelector}
                    onSelectValue={(_scope, type, value) => {
                      if (type === 'model') {
                        updateBridgeAgentRouting({
                          defaultModel: value,
                          defaultAuthProvider: selectedBridgeRoutingAgent.defaultAuthProvider ?? null,
                          defaultAuthChoice: selectedBridgeRoutingAgent.defaultAuthChoice ?? null,
                          fallbackModel: selectedBridgeRoutingAgent.fallbackModel ?? null,
                          fallbackAuthProvider: selectedBridgeRoutingAgent.fallbackAuthProvider ?? null,
                          fallbackAuthChoice: selectedBridgeRoutingAgent.fallbackAuthChoice ?? null,
                          thinking: defaultThinkingForBridgeModel(value, selectedBridgeRoutingAgent.thinking),
                          selectorType: 'model',
                        });
                      } else if (type === 'thinking') {
                        updateBridgeAgentRouting({
                          defaultModel: selectedBridgeRoutingAgent.defaultModel ?? null,
                          defaultAuthProvider: selectedBridgeRoutingAgent.defaultAuthProvider ?? null,
                          defaultAuthChoice: selectedBridgeRoutingAgent.defaultAuthChoice ?? null,
                          fallbackModel: selectedBridgeRoutingAgent.fallbackModel ?? null,
                          fallbackAuthProvider: selectedBridgeRoutingAgent.fallbackAuthProvider ?? null,
                          fallbackAuthChoice: selectedBridgeRoutingAgent.fallbackAuthChoice ?? null,
                          thinking: value,
                          selectorType: 'thinking',
                        });
                      }
                    }}
                    authLabel={composerAuthLabel}
                    authOptions={composerAuthOptions}
                    onSelectAuthChoice={() => {}}
                    onSelectProviderChoice={(_scope, option) => {
                      const nextModel = firstModelForProvider(option.providerId, chatModelOptions);
                      if (!nextModel) return;
                      updateBridgeAgentRouting({
                        defaultModel: nextModel,
                        defaultAuthProvider: option.providerId,
                        defaultAuthChoice: authChoiceFromProviderOption(option),
                        fallbackModel: selectedBridgeRoutingAgent.fallbackModel ?? null,
                        fallbackAuthProvider: selectedBridgeRoutingAgent.fallbackAuthProvider ?? null,
                        fallbackAuthChoice: selectedBridgeRoutingAgent.fallbackAuthChoice ?? null,
                        thinking: defaultThinkingForBridgeModel(nextModel, selectedBridgeRoutingAgent.thinking),
                        selectorType: 'provider',
                      });
                    }}
                    providerOptions={composerProviderOptions}
                    modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
                  />
                </div>
              ) : null}
              <Button
                className="app-composer-send h-10 w-10 shrink-0 rounded-full p-0"
                onClick={() => onSendChatMessage()}
                disabled={false}
                title={activeLiveTurnIsRunning ? 'Queue message for this session' : 'Send message'}
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
        </section>
        {showCompanionPane && companionSide === 'right' ? splitDivider : null}
        {showCompanionPane && companionSide === 'right' ? companionPane : null}
      </div>
    </div>
  );
}

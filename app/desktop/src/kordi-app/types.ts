import type { CollaborationMessageDirection } from '@/features/collaboration/messages';
import type { DesktopChatSessionSummary } from '@/features/chat/desktopChatSessionSummary';

import type {
  ComposerQuoteState,
  DesktopChatAttachment,
  DesktopChatToolSnapshot,
  DesktopChatTurnSnapshot,
  Message,
  MessageActionMetadata,
  MessageActionSource,
  MessageAttachment,
  MessageMention,
  MessageSourceReference,
  QueuedDesktopChatMessage,
  SessionArtifact,
  SessionStatusIndicator,
} from './types/message';
export type { Contact, ContactClass } from './types/contact';

export type {
  CollaborationAgentRequestControl,
  ComposerQuoteState,
  DesktopChatAttachment,
  DesktopArtifactDirectory,
  DesktopArtifactDirectoryEntry,
  DesktopArtifactPreview,
  ChangedFileRow,
  DesktopChatToolSnapshot,
  DesktopChatTurnSnapshot,
  EditDiffLine,
  EditFilePreview,
  Message,
  MessageActionMetadata,
  MessageActionSource,
  MessageAttachment,
  MessageMention,
  MessageReadReceiptParticipant,
  MessageReadReceiptSummary,
  MessageReplySummary,
  MessageSourceReference,
  QueuedDesktopChatMessage,
  SessionArtifact,
  SessionStatusIndicator,
  SourcePreviewLine,
} from './types/message';

export type NavId = 'chats' | 'contacts' | 'projects' | 'agents' | 'settings';
export type ChatChannel = 'contact' | 'agent';
export type DetailTab = 'info' | 'context' | 'artifacts' | 'tasks';
export type ConversationType = 'person' | 'owned-agent' | 'external-agent';
export type ResizeDirection =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';
export type PanelResizeTarget = 'session' | 'detail';
export type ThemeMode = 'auto' | 'dark' | 'light';
export type ResolvedThemeMode = Exclude<ThemeMode, 'auto'>;
export type ComposerScope = 'chat' | 'project';
export type ComposerSelectorType = 'mode' | 'auth' | 'provider' | 'model' | 'thinking';

export type OutreachThreadSummary = {
  id: string;
  title: string;
  subtitle: string;
  targetKind: 'agent' | 'person' | string;
  targetDisplayName: string;
  status: string;
  updatedAtLabel?: string;
};

export type ConversationParticipant = {
  id: string;
  kordiId?: string | null; // Public nine-digit identity, not the private Cloud account id.
  name: string;
  /** Canonical profile name used where viewer-local labels such as "Me" would diverge. */
  publicName?: string | null;
  kind: 'human' | 'agent' | string;
  role: string;
  source?: string | null;
  ownerIdentityId?: string | null;
  ownerName?: string | null;
  sourceHostId?: string | null;
  sourceIdentityId?: string | null;
  humanId?: string | null;
  agentId?: string | null;
  avatarKey?: string | null;
  profileImageUrl?: string | null;
  presenceStatus?: string | null;
  presenceDetail?: string | null;
};
export type ConversationCollaborationTarget = {
  hostId: string;
  nodeId: string;
  displayName?: string | null;
  ownerName?: string | null;
  runtime?: string | null;
  humanId?: string | null;
  agentId?: string | null;
};

export type SessionTaskParticipant = Pick<ConversationParticipant,
  | 'id'
  | 'name'
  | 'kind'
  | 'role'
  | 'source'
  | 'ownerIdentityId'
  | 'ownerName'
  | 'sourceHostId'
  | 'sourceIdentityId'
  | 'humanId'
  | 'agentId'
  | 'avatarKey'
  | 'profileImageUrl'
>;

export type SessionTaskActivity = {
  id: string;
  sessionId: string;
  status: string;
  initiator: SessionTaskParticipant | null;
  target: SessionTaskParticipant | null;
  participants: SessionTaskParticipant[];
  createdAtMs: number;
  updatedAtMs: number;
  sourceConversationId?: string | null;
  sourceRequestId?: string | null;
  contextPolicy: string;
  error?: string | null;
};

export type Conversation = {
  id: string;
  /** This server-owned conversation can submit a reviewed Kordi Support report. */
  supportTicketEnabled?: boolean;
  /** UI-only session draft. It must not be written to canonical storage before the first send. */
  transientDraft?: boolean;
  /** Internal activity timestamp used while composing workspace view models. */
  _updatedAtMs?: number;
  canonicalSessionId?: string;
  canonicalCreatedByIdentityId?: string;
  /** Canonical session creation time. Unlike `_updatedAtMs`, this never follows chat activity. */
  canonicalCreatedAtMs?: number;
  canonicalStoragePath?: string;
  canonicalParticipantCount?: number;
  canonicalMessageCount?: number;
  canonicalDelegatedExchangeCount?: number;
  taskActivities?: SessionTaskActivity[];
  canonicalContextSnapshotCount?: number;
  canonicalPresenceSummary?: string;
  localSessionCwd?: string | null;
  /** The native desktop chat runtime owns this transcript; canonical history is a secondary mirror. */
  desktopRuntimeBacked?: boolean;
  /** The native runtime transcript has been loaded and is authoritative for this render. */
  desktopRuntimeTranscriptLoaded?: boolean;
  name: string;
  type: ConversationType;
  subtitle: string;
  unread: number;
  unreadMentions?: number;
  collaborationSources: string[];
  trust: string;
  directness: string;
  participants: string[];
  canonicalParticipants?: ConversationParticipant[];
  messages: Message[];
  reflectionLessonArtifacts?: SessionArtifact[];
  contextWindowStatus?: DesktopChatContextWindowStatus;
  cacheMonitorText?: string | null;
  queuedMessages?: QueuedDesktopChatMessage[];
  previewLiveTurn?: DesktopChatTurnSnapshot | null;
  updatedAtLabel?: string;
  statusIndicator?: SessionStatusIndicator;
  profileImageUrl?: string | null;
  avatarSeed?: string | null;
  participantAvatarSeeds?: Record<string, string>;
  participantProfileImageUrls?: Record<string, string | null>;
  participantPresenceStatuses?: Record<string, string | null>;
  participantSpaceId?: string | null;
  metadata?: unknown;
  collaborationTarget?: ConversationCollaborationTarget | null;
  collaborationUnreadByParentSessionId?: Record<string, number>;
  outreach?: DesktopCollaborationOutreachMetadata | null;
  identity?: DesktopCollaborationIdentitySnapshot | null;
  outreachThreads?: OutreachThreadSummary[];
  /** Source session this conversation was forked from, if any. */
  forkedFromSessionId?: string | null;
  /** Source message entry id this conversation was forked at, if any. */
  forkedFromMessageId?: string | null;
};
export type ParticipantSpaceKind = 'self' | 'direct-human' | 'direct-agent' | 'group';

export type ParticipantSpaceAvatar = {
  kind: 'human' | 'agent';
  seed: string;
  isSelf?: boolean;
  imageUrl?: string | null;
  presenceStatus?: string | null;
};
export type ParticipantSpaceSessionViewModel = {
  id: string;
  canonicalSessionId?: string;
  title: string;
  preview: string;
  unread: number;
  updatedAtLabel?: string;
  updatedAtMs: number;
  participantCount: number;
  statusIndicator?: SessionStatusIndicator;
  conversation: Conversation;
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
};

export type ParticipantSpaceViewModel = {
  id: string;
  kind: ParticipantSpaceKind;
  title: string;
  participants: ConversationParticipant[];
  participantCount: number;
  sessionCount: number;
  unread: number;
  updatedAtLabel?: string;
  updatedAtMs: number;
  /** Creation time of the logical group root, not its oldest or latest chat activity. */
  createdAtMs?: number | null;
  preview: string;
  avatarStack: ParticipantSpaceAvatar[];
  sessions: ParticipantSpaceSessionViewModel[];
  groupCreatorIdentityId?: string | null;
  groupAdminIdentityIds?: string[];
  /** All persisted membership sessions, including hidden legacy empty shells. */
  membershipSessionIds?: string[];
  /** Hidden persisted blank continuation that can be reused instead of creating another shell. */
  reusableBlankSessionId?: string | null;
};

export type ContactRequest = {
  id: string;
  initials: string;
  title: string;
  detail: string;
  time: string;
  profileImageUrl?: string | null;
  avatarSeed?: string | null;
  avatarName?: string | null;
  source?: 'demo' | 'cloud' | 'collaboration' | string;
  sourceHostId?: string | null;
  sourceRequestId?: string | null;
  requesterNodeId?: string | null;
  targetNodeId?: string | null;
  status?: string | null;
  direction?: string | null;
};

export type AgentCollaborationReachout = {
  sessionId: string;
  title: string;
  preview: string;
  updatedAtLabel?: string;
  unread?: number;
};

export type Agent = {
  name: string;
  id: string;
  role: string;
  messaging: string;
  status: string;
  tasks: number;
  defaultProvider: string;
  defaultModel: string;
  defaultAuthProvider?: string | null;
  defaultAuthChoice?: string | null;
  fallbackModel?: string | null;
  fallbackAuthProvider?: string | null;
  fallbackAuthChoice?: string | null;
  defaultThinking?: string | null;
  collaborationConfig: string;
  contactId: string;
  systemPrompt: string;
  xMd: string;
  identityFiles: string[];
  loadedTools: string[];
  loadedSkills: string[];
  loadedPlugins: string[];
  lastActivities: string[];
  exposesIdentityFiles?: boolean;
  exposesLoadedSkills?: boolean;
  exposesLoadedTools?: boolean;
  exposesLoadedPlugins?: boolean;
  sourceHostId?: string;
  sourceParticipantId?: string;
  sourceRuntime?: string;
  sourceAgentId?: string;
  collaborationServerUrl?: string;
  collaborationOwnerName?: string;
  isOwned?: boolean;
  isCollaborationDefault?: boolean;
  isCollaborationActive?: boolean;
  isCollaborationRegistered?: boolean;
  cloudAgentId?: string;
  cloudAgentAccessScope?: 'private' | 'participant_conversations';
  cloudAgentOwnerAccountId?: string;
  cloudAgentDescription?: string | null;
  cloudAgentSourceSummary?: string | null;
  cloudAgentBoundaries?: string[];
  cloudAgentResources?: Array<{
    kind: string;
    value: string;
    title?: string | null;
    summary?: string | null;
  }>;
  cloudAgentSkills?: Array<{
    name: string;
    description: string;
    content?: string | null;
  }>;
  cloudAgentAvatarVersion?: number; cloudAgentAvatarSource?: 'generated' | 'uploaded'; avatarSeed?: string | null;
  profileImageUrl?: string | null;
  collaborationReachouts?: AgentCollaborationReachout[];
};

export type ProjectSession = {
  id: string;
  name: string;
  summary: string;
  lastActive: string;
  status: string;
  participants: string[];
  artifacts: number;
  tasks: number;
  taskActivities?: SessionTaskActivity[];
  canonicalParticipants?: ConversationParticipant[];
  unread: number;
  statusIndicator?: SessionStatusIndicator;
  reflectionLessonArtifacts?: SessionArtifact[];
  messages: Message[];
};

export type ProjectSharedSource = {
  label: string;
  path?: string | null;
  detail?: string | null;
};

export type Project = {
  id: string;
  name: string;
  summary: string;
  collaboration: string;
  scope: string;
  status: string;
  people: string[];
  agents: string[];
  pendingInvites: string[];
  artifacts: number;
  tasks: number;
  root?: string;
  sharedContext?: string;
  backgroundSystem?: string;
  sharedSources?: ProjectSharedSource[];
  sessions: ProjectSession[];
};

export type DesktopAuthOption = {
  value: string;
  profileId?: string | null;
  method: string;
  source: string;
  label: string;
  detail?: string | null;
  active: boolean;
  accountLabel?: string | null;
  authority?: string | null;
  configuredAtMs?: number | null;
  updatedAtMs?: number | null;
};

export type DesktopAuthProvider = {
  id: string;
  label: string;
  statusSummary: string;
  loginHint: string;
  envVar: string;
  helpUrl: string;
  supportsOAuth: boolean;
  supportsApiKey: boolean;
  configured: boolean;
  authority?: string | null;
  baseUrl?: string | null;
  preferredModel?: string | null;
  options: DesktopAuthOption[];
};

export type CanonicalLocalProfile = {
  id: string;
  displayName?: string | null;
  humanIdentityId?: string | null;
  activeAgentIdentityId?: string | null;
  storageRoot: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CanonicalIdentity = {
  id: string;
  kind: 'human' | 'agent' | string;
  displayName: string;
  ownerIdentityId?: string | null;
  source: 'local' | 'cloud' | 'collaboration' | 'imported' | string;
  sourceHostId?: string | null;
  sourceIdentityId?: string | null;
  humanId?: string | null;
  agentId?: string | null;
  avatarKey: string;
  profileImageUrl?: string | null;
  metadata?: unknown;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CanonicalSession = {
  id: string;
  kind: 'self-agent' | 'direct-person' | 'direct-agent' | 'relationship' | 'group' | 'project' | string;
  title: string;
  status: 'active' | 'archived' | 'draft' | string;
  createdByIdentityId: string;
  primaryIdentityId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  relationshipIdentityId?: string | null;
  metadata?: unknown;
  createdAtMs: number;
  updatedAtMs: number;
  lastMessageAtMs?: number | null;
};

export type CanonicalSessionParticipant = {
  sessionId: string;
  identityId: string;
  role: 'self' | 'admin' | 'owned-agent' | 'person' | 'external-agent' | 'delegate' | string;
  state: 'active' | 'invited' | 'pending' | 'left' | string;
  addedByIdentityId?: string | null;
  addedAtMs: number;
  lastSeenAtMs?: number | null;
  lastReadMessageId?: string | null;
  lastReadSequenceNum?: number | null;
  metadata?: unknown;
};

export type CanonicalSessionMessage = {
  id: string;
  sessionId: string;
  senderIdentityId: string;
  senderRole: 'user' | 'owned-agent' | 'external-agent' | 'person' | 'system' | string;
  messageKind: 'text' | 'agent-turn' | 'delegation-request' | 'delegation-response' | 'system' | 'status' | string;
  contentText: string;
  content?: unknown;
  parentMessageId?: string | null;
  delegatedExchangeId?: string | null;
  status: 'draft' | 'sending' | 'sent' | 'delivered' | 'read' | 'processing' | 'complete' | 'failed' | string;
  sequenceNum: number;
  createdAtMs: number;
  updatedAtMs: number;
  contentHash?: string | null;
  sourceTransport?: string | null;
  sourceEventId?: string | null;
};

export type CanonicalDelegatedExchange = {
  id: string;
  sessionId: string;
  initiatorIdentityId: string;
  targetIdentityId: string;
  triggerMessageId?: string | null;
  requestMessageId?: string | null;
  responseMessageId?: string | null;
  transport: 'cloud' | 'collaboration' | 'local' | 'internal' | string;
  sourceHostId?: string | null;
  sourceConversationId?: string | null;
  sourceRequestId?: string | null;
  contextPolicy: 'last-message' | 'recent-window' | 'summary' | 'full-session' | string;
  status: 'pending' | 'sending' | 'processing' | 'complete' | 'failed' | 'cancelled' | 'timeout' | string;
  error?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CanonicalPresence = {
  identityId: string;
  status: 'online' | 'offline' | 'away' | 'typing' | 'running' | 'replying' | 'error' | string;
  sessionId?: string | null;
  detail?: string | null;
  updatedAtMs: number;
  expiresAtMs?: number | null;
};

export type CanonicalContextSnapshot = {
  id: string;
  profileId: string;
  sessionId: string;
  agentIdentityId: string;
  provider: string;
  model: string;
  promptHash: string;
  projectContextHash?: string | null;
  participantHash: string;
  uptoMessageId?: string | null;
  messageRangeHash: string;
  summaryText?: string | null;
  summaryJson?: unknown;
  tokenCount?: number | null;
  createdAtMs: number;
  invalidatedAtMs?: number | null;
};

export type CanonicalSessionState = {
  storagePath: string;
  profile: CanonicalLocalProfile;
  identities: CanonicalIdentity[];
  sessions: CanonicalSession[];
  participants: CanonicalSessionParticipant[];
  messages: CanonicalSessionMessage[];
  delegatedExchanges: CanonicalDelegatedExchange[];
  presence: CanonicalPresence[];
  contextSnapshots: CanonicalContextSnapshot[];
};

export type CanonicalProfileIdentityDelta = {
  profile: CanonicalLocalProfile;
  identity: CanonicalIdentity;
  previousIdentityId: string | null;
  groupSelfSessionIds: string[];
};

export type CanonicalSessionSummary = {
  sessionId: string;
  messageCount: number;
  latestMessage: CanonicalSessionMessage | null;
  contextSnapshotCount: number;
};

export type CanonicalSessionCatalog = Omit<CanonicalSessionState, 'messages' | 'contextSnapshots'> & {
  summaries: CanonicalSessionSummary[];
};

export type CanonicalMessagePage = {
  sessionId: string;
  messages: CanonicalSessionMessage[];
  oldestSequenceNum: number | null;
  newestSequenceNum: number | null;
  hasOlder: boolean;
};

export type CanonicalReadCursorDelta = {
  sessionId: string;
  identityId: string;
  lastSeenAtMs: number;
  lastReadMessageId: string | null;
  lastReadSequenceNum: number | null;
};

export type CanonicalMessageDeliveryDelta = {
  messageId: string;
  sessionId: string;
  status: 'sending' | 'delivered' | 'failed';
  deliveryState: 'sending' | 'partial' | 'delivered' | 'failed';
  deliveredRecipientIds: string[];
  pendingRecipientIds: string[];
  exhaustedRecipientIds: string[];
  updatedAtMs: number;
  contentHash: string;
  sessionUpdatedAtMs: number;
  sessionLastMessageAtMs: number | null;
};

export type OpenCanonicalSessionFastResult = {
  session: CanonicalSession;
  participants: CanonicalSessionParticipant[];
};

export type CanonicalGroupMembershipDelta = {
  sessions: CanonicalSession[];
  participants: CanonicalSessionParticipant[];
  messages: CanonicalSessionMessage[];
};

export type UpsertCanonicalIdentityRequest = {
  id?: string | null;
  kind: 'human' | 'agent';
  displayName: string;
  ownerIdentityId?: string | null;
  source?: 'local' | 'cloud' | 'collaboration' | 'imported' | string | null;
  sourceHostId?: string | null;
  sourceIdentityId?: string | null;
  humanId?: string | null;
  agentId?: string | null;
  avatarKey?: string | null;
  profileImageUrl?: string | null;
  metadata?: unknown;
};

export type AdoptCloudProfileIdentityRequest = {
  accountId: string;
  displayName: string;
  avatarKey?: string | null;
  profileImageUrl?: string | null;
};

export type OpenCanonicalSessionRequest = {
  id?: string | null;
  kind: 'self-agent' | 'direct-person' | 'direct-agent' | 'relationship' | 'group' | 'project';
  title?: string | null;
  status?: 'active' | 'archived' | 'draft' | string | null;
  createdByIdentityId: string;
  primaryIdentityId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  relationshipIdentityId?: string | null;
  participantIdentityIds: string[];
  metadata?: unknown;
};

export type AppendCanonicalMessageRequest = {
  id?: string | null;
  sessionId: string;
  senderIdentityId: string;
  senderRole: 'user' | 'owned-agent' | 'external-agent' | 'person' | 'system' | string;
  messageKind: 'text' | 'agent-turn' | 'delegation-request' | 'delegation-response' | 'system' | 'status' | string;
  contentText: string;
  content?: unknown;
  createdAtMs?: number | null;
  parentMessageId?: string | null;
  delegatedExchangeId?: string | null;
  status?: string | null;
  sourceTransport?: string | null;
  sourceEventId?: string | null;
};

export type UpdateCanonicalMessageDeliveryRequest = {
  messageId: string;
  sessionId: string;
  status: 'sending' | 'delivered' | 'failed';
  deliveryState: 'sending' | 'partial' | 'delivered' | 'failed';
  deliveredRecipientIds: string[];
  pendingRecipientIds: string[];
  exhaustedRecipientIds: string[];
};

export type CreateCanonicalDelegatedExchangeRequest = {
  id?: string | null;
  sessionId: string;
  initiatorIdentityId: string;
  targetIdentityId: string;
  triggerMessageId?: string | null;
  requestMessageId?: string | null;
  responseMessageId?: string | null;
  transport?: 'cloud' | 'collaboration' | 'local' | 'internal' | string | null;
  sourceHostId?: string | null;
  sourceConversationId?: string | null;
  sourceRequestId?: string | null;
  contextPolicy?: 'last-message' | 'recent-window' | 'summary' | 'full-session' | string | null;
  status?: string | null;
  error?: string | null;
};

export type UpdateCanonicalPresenceRequest = {
  identityId: string;
  status: 'online' | 'offline' | 'away' | 'typing' | 'running' | 'replying' | 'error' | string;
  sessionId?: string | null;
  detail?: string | null;
  expiresAtMs?: number | null;
};

export type RenameCanonicalSessionRequest = {
  sessionId: string;
  title: string;
  requestedByIdentityId?: string | null;
};

export type UpdateCanonicalSessionMetadataRequest = {
  sessionId: string;
  metadata: unknown;
  requestedByIdentityId?: string | null;
};

export type AddCanonicalSessionParticipantsRequest = {
  sessionId: string;
  identityIds: string[];
  addedByIdentityId: string;
};

export type AddCanonicalGroupMembersRequest = {
  sessions: Array<{
    sessionId: string;
    groupSpaceId: string;
    addedContactIds: string[];
    addedParticipantNames: string[];
  }>;
  identityIds: string[];
  addedByIdentityId: string;
  joinEvents: Array<{
    eventId: string;
    memberIdentityId: string;
    createdAtMs: number;
  }>;
};

export type RemoveCanonicalSessionParticipantRequest = {
  sessionId: string;
  identityId: string;
  removedByIdentityId?: string | null;
};

export type SetCanonicalSessionParticipantRoleRequest = {
  sessionId: string;
  identityId: string;
  role: 'self' | 'admin' | 'person' | 'delegate' | string;
  requestedByIdentityId?: string | null;
};

export type MarkCanonicalSessionReadRequest = {
  sessionId: string;
  identityId?: string | null;
  messageId?: string | null;
};

export type DesktopAuthState = {
  authPath: string;
  hasAnyAuth: boolean;
  providers: DesktopAuthProvider[];
};

export type DesktopAuthAttemptSnapshot = {
  id: string;
  provider: string;
  status: string;
  message: string;
  authUrl?: string | null;
  browserOpened: boolean;
  verificationUrl?: string | null;
  userCode?: string | null;
  canPasteCallback: boolean;
  completed: boolean;
  succeeded: boolean;
  error?: string | null;
};

export type DesktopChatModelOption = {
  provider: string;
  providerLabel: string;
  value: string;
  label: string;
  detail: string;
  thinkingLevels: string[];
};

export type DesktopChatSlashCommand = {
  label: string;
  detail?: string | null;
  value: string;
};

export type DesktopChatMessage = {
  role: string;
  sender?: string | null;
  text: string;
  detail?: string | null;
  timeLabel: string;
  timestampMs: number;
  failed?: boolean;
  cancelled?: boolean;
  attachments?: DesktopChatAttachment[];
  mentions?: MessageMention[];
  replyToMessageId?: string | null;
  messageAction?: MessageActionMetadata | null;
  thinkingText?: string | null;
  tools?: DesktopChatToolSnapshot[];
  turnStartedAtMs?: number | null;
  turnCompletedAtMs?: number | null;
  transcriptRenderId?: string | null; // Ephemeral renderer identity; never persisted.
  /** Stable id of the underlying session entry; only set for messages
   * that map 1:1 to a SessionEntry (e.g., user messages). */
  entryId?: string | null;
};
export type { DesktopChatSessionSummary };

export type DesktopChatProjectGroup = {
  id: string;
  name: string;
  root: string;
  summary: string;
  backgroundSystem?: string | null;
  sharedSources: DesktopChatProjectSource[];
  sessions: DesktopChatSessionSummary[];
};

export type DesktopChatContextWindowStatus = {
  contextWindow: number;
  usedTokens?: number | null;
  usedPercent?: number | null;
  autoCompaction: boolean;
  compactionThresholdPercent?: number;
};

export type DesktopChatProjectSource = {
  label: string;
  path?: string | null;
  detail?: string | null;
};

export type DesktopCollaborationPeer = {
  nodeId: string;
  displayName?: string | null;
  runtime: string;
  endpoint: string;
  ownerName?: string | null;
  createdAt?: string | null;
  sharedProjects: string[];
  humanId?: string | null;
  agentId?: string | null;
  isDefaultAgent?: boolean;
  discoveryMode?: string | null;
  humanVisibilityPolicy?: string | null;
  contactApprovalPolicy?: string | null;
  agentReachabilityPolicy?: string | null;
  isContact?: boolean;
  contactRequestStatus?: string | null;
  contactRequestDirection?: string | null;
  profileImageUrl?: string | null;
  avatarSeed?: string | null;
};

export type DesktopCollaborationProject = {
  id: string;
  name: string;
  memberCount: number;
};

export type DesktopCollaborationAgent = {
  id: string;
  label: string;
  nodeId?: string | null;
  runtime: string;
  isDefault: boolean;
  isActive: boolean;
  registered: boolean;
  defaultModel?: string | null;
  defaultAuthProvider?: string | null;
  defaultAuthChoice?: string | null;
  fallbackModel?: string | null;
  fallbackAuthProvider?: string | null;
  fallbackAuthChoice?: string | null;
  thinking?: string | null;
  reachabilityPolicy?: string | null;
  profileImageUrl?: string | null;
};

export type DesktopCollaborationContactRequest = {
  requestId: string;
  requesterNodeId: string;
  targetNodeId: string;
  status: string;
  message?: string | null;
  createdAt: string;
  decidedAt?: string | null;
  direction: string;
};

export type DesktopCollaborationHost = {
  id: string;
  registered: boolean;
  connected: boolean;
  serverUrl: string;
  nodeId?: string | null;
  displayName: string;
  ownerName: string;
  endpoint: string;
  tokenPresent: boolean;
  humanId: string;
  discoveryMode: string;
  humanVisibilityPolicy?: string | null;
  contactApprovalPolicy?: string | null;
  profileImageUrl?: string | null;
  activeAgentId?: string | null;
  agents: DesktopCollaborationAgent[];
  visiblePeers: DesktopCollaborationPeer[];
  visiblePeerCount: number;
  projects: DesktopCollaborationProject[];
  contactRequests?: DesktopCollaborationContactRequest[];
  lastError?: string | null;
};

export type DesktopCollaborationConversationMessage = {
  id: string;
  clientMessageId?: string | null;
  direction: CollaborationMessageDirection;
  sender?: string | null;
  text: string;
  timeLabel: string;
  timestampMs: number;
  requestId?: string | null;
  deliveryState?: string | null;
  detail?: string | null;
  outreach?: DesktopCollaborationOutreachMetadata | null;
  attachments?: MessageAttachment[];
  mentions?: MessageMention[];
  messageAction?: MessageActionMetadata | null;
  messageKind?: string | null;
  localTurn?: DesktopChatTurnSnapshot | null; reactionConversationId?: string | null; reactionTargetMessageId?: string | null; reactions?: Array<{ value: string; accountIds: string[] }>;
};
export type DesktopCollaborationSessionThreadMessage = {
  role: Message['role'] | string;
  sender?: string | null;
  text: string;
  timeLabel?: string | null;
  index?: number | null;
  tools?: DesktopChatToolSnapshot[];
};

export type DesktopCollaborationSessionParticipant = {
  identityId?: string | null;
  displayName: string;
  kind?: string | null;
  role?: string | null;
  ownerIdentityId?: string | null;
  ownerDisplayName?: string | null;
  sourceIdentityId?: string | null;
  humanId?: string | null;
  agentId?: string | null;
  runtime?: string | null;
  avatarKey?: string | null;
  profileImageUrl?: string | null;
};

export type DesktopCollaborationPromptIdentity = {
  identityId?: string | null;
  displayName: string;
  kind: string;
  ownerIdentityId?: string | null;
  ownerDisplayName?: string | null;
  sourceIdentityId?: string | null;
  humanId?: string | null;
  agentId?: string | null;
  runtime?: string | null;
};

export type DesktopCollaborationOutreachMetadata = {
  targetKind: 'agent' | 'person' | string;
  parentSessionId?: string | null;
  parentSessionTitle?: string | null;
  parentSessionKind?: string | null;
  parentGroupSpaceId?: string | null;
  parentSessionParticipants?: DesktopCollaborationSessionParticipant[];
  parentSessionMessages?: DesktopCollaborationSessionThreadMessage[];
  initiatorIdentity?: DesktopCollaborationPromptIdentity | null;
  selfTargetIdentity?: DesktopCollaborationPromptIdentity | null;
  parentTurnId?: string | null;
  parentMessageId?: string | null;
  sourceHostId: string;
  sourceConversationId?: string | null;
  sourceRequestId?: string | null;
  targetNodeId: string;
  targetHumanId?: string | null;
  targetAgentId?: string | null;
  targetDisplayName: string;
  targetOwnerName?: string | null;
  targetRuntime?: string | null;
  requestText: string;
  triggerText?: string | null;
  contextText?: string | null;
  contextPolicy?: 'last-message' | 'recent-window' | 'summary' | 'full-session' | string | null;
  projectId?: string | null;
  projectName?: string | null;
  status: 'sending' | 'awaitingReply' | 'complete' | 'failed' | 'cancelled' | string;
  deliveryState?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number | null;
  error?: string | null;
  localTurn?: DesktopChatTurnSnapshot | null;
};

export type DesktopCollaborationIdentitySnapshot = {
  sourceHostId: string;
  localHumanId: string;
  localHumanName: string;
  localAgentId?: string | null;
  localAgentName?: string | null;
  localAgentNodeId?: string | null;
  remoteHumanId?: string | null;
  remoteHumanName?: string | null;
  remoteHumanNodeId?: string | null;
  remoteAgentId?: string | null;
  remoteAgentName?: string | null;
  remoteAgentNodeId?: string | null;
  remoteAgentRuntime?: string | null;
};

export type DesktopCollaborationConversation = {
  id: string;
  supportTicketEnabled?: boolean;
  canonicalSessionId: string;
  hostId: string;
  peerNodeId: string;
  peerDisplayName?: string | null;
  peerOwnerName?: string | null;
  peerRuntime: string;
  projectId?: string | null;
  projectName?: string | null;
  title: string;
  subtitle: string;
  unreadCount: number;
  updatedAtMs: number;
  updatedAtLabel: string;
  awaitingReply: boolean;
  peerTyping: boolean;
  peerLastHeartbeatLabel?: string | null;
  outreach?: DesktopCollaborationOutreachMetadata | null;
  identity?: DesktopCollaborationIdentitySnapshot | null;
  messages: DesktopCollaborationConversationMessage[];
};

export type DesktopCollaborationCreateOutreachRequest = {
  hostId: string;
  targetNodeId: string;
  targetKind: 'agent' | 'person';
  requestText: string;
  targetDisplayName?: string | null;
  targetOwnerName?: string | null;
  targetRuntime?: string | null;
  targetHumanId?: string | null;
  targetAgentId?: string | null;
  triggerText?: string | null;
  contextText?: string | null;
  contextPolicy?: 'last-message' | 'recent-window' | 'summary' | 'full-session' | string | null;
  parentSessionId?: string | null;
  parentSessionTitle?: string | null;
  parentSessionKind?: string | null;
  parentGroupSpaceId?: string | null;
  parentSessionParticipants?: DesktopCollaborationSessionParticipant[];
  parentSessionMessages?: DesktopCollaborationSessionThreadMessage[];
  initiatorIdentity?: DesktopCollaborationPromptIdentity | null;
  selfTargetIdentity?: DesktopCollaborationPromptIdentity | null;
  parentTurnId?: string | null;
  parentMessageId?: string | null;
  sourceRequestId?: string | null;
  deliveryState?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  attachmentPaths?: string[];
  attachmentNames?: string[];
};

export type DesktopCollaborationInvite = {
  hostId: string;
  projectId: string;
  inviteId: string;
  inviteToken: string;
  shareText: string;
};

export type DesktopCollaborationAgentRouting = {
  defaultModel?: string | null;
  defaultAuthProvider?: string | null;
  defaultAuthChoice?: string | null;
  fallbackModel?: string | null;
  fallbackAuthProvider?: string | null;
  fallbackAuthChoice?: string | null;
  thinking?: string | null;
};

export type DesktopCollaborationState = {
  activeHostId?: string | null;
  hosts: DesktopCollaborationHost[];
  conversations: DesktopCollaborationConversation[];
  localAgentRouting?: DesktopCollaborationAgentRouting | null;
};

export type DesktopProjectSettings = {
  root: string;
  name: string;
  context: string;
  systemPrompt: string;
  sharedSources: DesktopChatProjectSource[];
};

export type DesktopChatProjectInfo = {
  name: string;
  root: string;
  sharedContext?: string | null;
  backgroundSystem?: string | null;
  sharedSources: DesktopChatProjectSource[];
};

export type DesktopChatSessionDetail = {
  id: string;
  cwd: string;
  title: string;
  subtitle: string;
  provider: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  thinking: string;
  thinkingLabel: string;
  thinkingLevels: string[];
  updatedAtLabel: string;
  updatedAtMs: number;
  messageCount: number;
  draft: boolean;
  cacheMonitorText?: string | null;
  contextWindowText: string;
  contextWindowStatus: DesktopChatContextWindowStatus;
  project?: DesktopChatProjectInfo | null;
  reflectionLessonArtifacts?: SessionArtifact[];
  messages: DesktopChatMessage[];
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
};

export type DesktopChatAgentProfile = {
  label: string;
  systemPrompt: string;
  loadedSkills: string[];
  loadedTools: string[];
  loadedPlugins: string[];
  identityFiles: string[];
  defaultProvider: string;
  defaultModel: string;
  workspaceRoot: string;
  lastActivities: string[];
};
export type DesktopChatState = {
  cwd: string;
  activeSessionId: string;
  sessions: DesktopChatSessionSummary[];
  projects: DesktopChatProjectGroup[];
  activeSession: DesktopChatSessionDetail;
  localAgent: DesktopChatAgentProfile;
  modelOptions: DesktopChatModelOption[];
  slashCommands: DesktopChatSlashCommand[];
};

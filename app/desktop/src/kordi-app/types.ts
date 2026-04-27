import type { BridgeMessageDirection } from '@/features/bridge/messages';

export type NavId = 'chats' | 'contacts' | 'projects' | 'agents' | 'bridge' | 'settings';
export type ChatFilter = 'all' | 'people' | 'agents' | 'delegated';
export type DetailTab = 'info' | 'context' | 'artifacts' | 'tasks';
export type ConversationType = 'person' | 'owned-agent' | 'external-agent';
export type ContactClass = 'my-agents' | 'other-users-agents' | 'other-users';
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

export type EditDiffLine = {
  kind: 'context' | 'add' | 'remove';
  oldNumber?: number;
  newNumber?: number;
  text: string;
};

export type SourcePreviewLine = {
  number: number;
  text: string;
  kind?: 'context' | 'add';
};

export type SessionArtifact = {
  id: string;
  path: string;
  name: string;
  kind: 'code' | 'document' | 'file';
  summary: string;
  timeLabel?: string;
  live?: boolean;
};

export type DesktopArtifactPreview = {
  path: string;
  lines: SourcePreviewLine[];
  truncated: boolean;
};

export type DesktopArtifactDirectoryEntry = {
  name: string;
  path: string;
  kind: 'directory' | SessionArtifact['kind'];
  isDirectory: boolean;
  sizeBytes?: number | null;
};

export type DesktopArtifactDirectory = {
  path: string;
  parentPath?: string | null;
  entries: DesktopArtifactDirectoryEntry[];
};

export type EditFilePreview = {
  path: string;
  additions: number;
  deletions: number;
  lines: EditDiffLine[];
  sourceLines?: SourcePreviewLine[];
};

export type MessageAttachment = {
  kind: 'image' | 'file';
  name: string;
  formatLabel?: string | null;
  previewUrl?: string | null;
  mimeType?: string | null;
};

export type MessageMention = {
  label: string;
  targetKind?: 'bridge-agent' | 'bridge-person' | string;
  bridgeHostId?: string | null;
  nodeId?: string | null;
  humanId?: string | null;
  agentId?: string | null;
};

export type Message = {
  role: 'system' | 'user' | 'owned-agent' | 'external-agent' | 'person' | 'action' | 'edit';
  sender?: string;
  senderType?: 'human' | 'agent';
  senderProfileImageUrl?: string | null;
  senderAvatarSeed?: string | null;
  isOwnMessage?: boolean;
  showSenderMeta?: boolean;
  text: string;
  time: string;
  detail?: string;
  statusChips?: string[];
  attachments?: MessageAttachment[];
  mentions?: MessageMention[];
  turn?: DesktopChatTurnSnapshot;
  edit?: {
    files: EditFilePreview[];
  };
};

export type SessionStatusIndicator = {
  label: string;
  tone: 'running' | 'ready' | 'draft' | 'error' | 'stopped';
  live?: boolean;
};

export type OutreachThreadSummary = {
  id: string;
  title: string;
  subtitle: string;
  targetKind: 'bridge-agent' | 'bridge-person' | string;
  targetDisplayName: string;
  status: string;
  updatedAtLabel?: string;
};

export type ConversationParticipant = {
  id: string;
  name: string;
  kind: 'human' | 'agent' | string;
  role: string;
  source?: string | null;
  ownerIdentityId?: string | null;
  ownerName?: string | null;
  bridgeHostId?: string | null;
  bridgeNodeId?: string | null;
  humanId?: string | null;
  agentId?: string | null;
  avatarKey?: string | null;
  profileImageUrl?: string | null;
  presenceStatus?: string | null;
  presenceDetail?: string | null;
};

export type ConversationBridgeTarget = {
  hostId: string;
  nodeId: string;
  displayName?: string | null;
  ownerName?: string | null;
  runtime?: string | null;
  humanId?: string | null;
  agentId?: string | null;
};

export type Conversation = {
  id: string;
  canonicalSessionId?: string;
  canonicalStoragePath?: string;
  canonicalParticipantCount?: number;
  canonicalMessageCount?: number;
  canonicalDelegatedExchangeCount?: number;
  canonicalContextSnapshotCount?: number;
  canonicalPresenceSummary?: string;
  name: string;
  type: ConversationType;
  subtitle: string;
  unread: number;
  bridges: string[];
  trust: string;
  directness: string;
  participants: string[];
  canonicalParticipants?: ConversationParticipant[];
  messages: Message[];
  contextWindowStatus?: DesktopChatContextWindowStatus;
  cacheMonitorText?: string | null;
  queuedMessages?: QueuedDesktopChatMessage[];
  previewLiveTurn?: DesktopChatTurnSnapshot | null;
  updatedAtLabel?: string;
  statusIndicator?: SessionStatusIndicator;
  profileImageUrl?: string | null;
  avatarSeed?: string | null;
  participantAvatarSeeds?: Record<string, string>;
  bridgeTarget?: ConversationBridgeTarget | null;
  outreach?: DesktopBridgeOutreachMetadata | null;
  identity?: DesktopBridgeIdentitySnapshot | null;
  outreachThreads?: OutreachThreadSummary[];
};

export type Contact = {
  id: string;
  name: string;
  initials: string;
  classType: ContactClass;
  entityType: string;
  subtitle: string;
  bridges: string[];
  status: string;
  discoverableOn: string[];
  detail: string;
  owner: string;
  bridgeHostId?: string;
  bridgePeerNodeId?: string;
  bridgePeerRuntime?: string;
  bridgeHumanId?: string | null;
  bridgeAgentId?: string | null;
  avatarSeed?: string | null;
  profileImageUrl?: string | null;
};

export type ContactRequest = {
  id: string;
  initials: string;
  title: string;
  detail: string;
  time: string;
  profileImageUrl?: string | null;
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
  bridgesConfig: string;
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
  bridgeHostId?: string;
  bridgePeerNodeId?: string;
  bridgePeerRuntime?: string;
  bridgeAgentId?: string;
  bridgeServerUrl?: string;
  bridgeOwnerName?: string;
  isOwned?: boolean;
  isBridgeDefault?: boolean;
  isBridgeActive?: boolean;
  isBridgeRegistered?: boolean;
  avatarSeed?: string | null;
  profileImageUrl?: string | null;
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
  unread: number;
  statusIndicator?: SessionStatusIndicator;
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
  bridge: string;
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
  source: 'local' | 'bridge' | 'imported' | string;
  sourceHostId?: string | null;
  bridgeNodeId?: string | null;
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
  role: 'self' | 'owned-agent' | 'person' | 'external-agent' | 'delegate' | string;
  state: 'active' | 'invited' | 'pending' | 'left' | string;
  addedByIdentityId?: string | null;
  addedAtMs: number;
  lastSeenAtMs?: number | null;
  lastReadMessageId?: string | null;
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
  transport: 'bridge' | 'local' | 'internal' | string;
  bridgeHostId?: string | null;
  bridgeConversationId?: string | null;
  bridgeRequestId?: string | null;
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

export type UpsertCanonicalIdentityRequest = {
  id?: string | null;
  kind: 'human' | 'agent';
  displayName: string;
  ownerIdentityId?: string | null;
  source?: 'local' | 'bridge' | 'imported' | string | null;
  sourceHostId?: string | null;
  bridgeNodeId?: string | null;
  humanId?: string | null;
  agentId?: string | null;
  avatarKey?: string | null;
  profileImageUrl?: string | null;
  metadata?: unknown;
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

export type CreateCanonicalDelegatedExchangeRequest = {
  id?: string | null;
  sessionId: string;
  initiatorIdentityId: string;
  targetIdentityId: string;
  triggerMessageId?: string | null;
  requestMessageId?: string | null;
  responseMessageId?: string | null;
  transport?: 'bridge' | 'local' | 'internal' | string | null;
  bridgeHostId?: string | null;
  bridgeConversationId?: string | null;
  bridgeRequestId?: string | null;
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
};

export type DesktopChatSlashCommand = {
  label: string;
  detail?: string | null;
  value: string;
};

export type DesktopChatAttachment = {
  kind: 'image' | 'file';
  name: string;
  formatLabel?: string | null;
  previewUrl?: string | null;
};

export type DesktopChatMessage = {
  role: string;
  sender?: string | null;
  text: string;
  detail?: string | null;
  timeLabel: string;
  timestampMs: number;
  failed?: boolean;
  attachments?: DesktopChatAttachment[];
  mentions?: MessageMention[];
  thinkingText?: string | null;
  tools?: DesktopChatToolSnapshot[];
};

export type DesktopChatSessionSummary = {
  id: string;
  title: string;
  subtitle: string;
  updatedAtLabel: string;
  messageCount: number;
  draft: boolean;
};

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

export type DesktopBridgePeer = {
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
  profileImageUrl?: string | null;
};

export type DesktopBridgeProject = {
  id: string;
  name: string;
  memberCount: number;
};

export type DesktopBridgeAgent = {
  id: string;
  label: string;
  nodeId?: string | null;
  runtime: string;
  isDefault: boolean;
  isActive: boolean;
  registered: boolean;
  profileImageUrl?: string | null;
};

export type DesktopBridgeHost = {
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
  activeAgentId?: string | null;
  agents: DesktopBridgeAgent[];
  visiblePeers: DesktopBridgePeer[];
  visiblePeerCount: number;
  projects: DesktopBridgeProject[];
  lastError?: string | null;
};

export type DesktopBridgeConversationMessage = {
  id: string;
  direction: BridgeMessageDirection;
  sender?: string | null;
  text: string;
  timeLabel: string;
  timestampMs: number;
  requestId?: string | null;
  deliveryState?: string | null;
  outreach?: DesktopBridgeOutreachMetadata | null;
};

export type DesktopBridgeSessionThreadMessage = {
  role: Message['role'] | string;
  sender?: string | null;
  text: string;
  timeLabel?: string | null;
  index?: number | null;
};

export type DesktopBridgeOutreachMetadata = {
  targetKind: 'bridge-agent' | 'bridge-person' | string;
  parentSessionId?: string | null;
  parentSessionTitle?: string | null;
  parentSessionMessages?: DesktopBridgeSessionThreadMessage[];
  parentTurnId?: string | null;
  parentMessageId?: string | null;
  bridgeHostId: string;
  bridgeConversationId?: string | null;
  bridgeRequestId?: string | null;
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
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number | null;
  error?: string | null;
};

export type DesktopBridgeIdentitySnapshot = {
  bridgeHostId: string;
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

export type DesktopBridgeConversation = {
  id: string;
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
  outreach?: DesktopBridgeOutreachMetadata | null;
  identity?: DesktopBridgeIdentitySnapshot | null;
  messages: DesktopBridgeConversationMessage[];
};

export type DesktopBridgeCreateOutreachRequest = {
  hostId: string;
  targetNodeId: string;
  targetKind: 'bridge-agent' | 'bridge-person';
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
  parentSessionMessages?: DesktopBridgeSessionThreadMessage[];
  parentTurnId?: string | null;
  parentMessageId?: string | null;
  bridgeRequestId?: string | null;
  deliveryState?: string | null;
  projectId?: string | null;
  projectName?: string | null;
};

export type DesktopBridgeLocalServerStatus = {
  running: boolean;
  serverUrl?: string | null;
  port?: number | null;
  dbPath?: string | null;
  launcher?: string | null;
  lastError?: string | null;
};

export type DesktopBridgeInvite = {
  hostId: string;
  projectId: string;
  inviteId: string;
  inviteToken: string;
  shareText: string;
};

export type DesktopBridgeState = {
  configPath: string;
  legacyConfigPath: string;
  conversationsPath: string;
  activeHostId?: string | null;
  hosts: DesktopBridgeHost[];
  conversations: DesktopBridgeConversation[];
  localServer: DesktopBridgeLocalServerStatus;
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
  title: string;
  subtitle: string;
  provider: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  thinking: string;
  thinkingLabel: string;
  updatedAtLabel: string;
  messageCount: number;
  draft: boolean;
  cacheMonitorText?: string | null;
  contextWindowText: string;
  contextWindowStatus: DesktopChatContextWindowStatus;
  project?: DesktopChatProjectInfo | null;
  messages: DesktopChatMessage[];
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

export type DesktopChatToolSnapshot = {
  id: string;
  name: string;
  status: string;
  arguments: string;
  liveOutput: string;
  resultText?: string | null;
  detail?: string | null;
  isError: boolean;
};

export type QueuedDesktopChatMessage = {
  id: string;
  sessionId: string;
  scope: 'chat' | 'project';
  text: string;
  time: string;
  attachments: (MessageAttachment & { id: string; path: string })[];
};

export type DesktopChatTurnSnapshot = {
  id: string;
  sessionId: string;
  prompt: string;
  status: string;
  message: string;
  assistantText: string;
  thinkingText: string;
  tools: DesktopChatToolSnapshot[];
  completed: boolean;
  succeeded: boolean;
  error?: string | null;
};

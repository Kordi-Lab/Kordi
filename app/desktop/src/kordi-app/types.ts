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
export type ThemeMode = 'dark' | 'light';
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

export type EditFilePreview = {
  path: string;
  additions: number;
  deletions: number;
  lines: EditDiffLine[];
  sourceLines?: SourcePreviewLine[];
};

export type Message = {
  role: 'system' | 'user' | 'owned-agent' | 'external-agent' | 'person' | 'action' | 'edit';
  sender?: string;
  text: string;
  time: string;
  detail?: string;
  statusChips?: string[];
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

export type Conversation = {
  id: string;
  name: string;
  type: ConversationType;
  subtitle: string;
  unread: number;
  bridges: string[];
  trust: string;
  directness: string;
  participants: string[];
  messages: Message[];
  updatedAtLabel?: string;
  statusIndicator?: SessionStatusIndicator;
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
};

export type ContactRequest = {
  id: string;
  initials: string;
  title: string;
  detail: string;
  time: string;
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
  lastActivities: string[];
  bridgeHostId?: string;
  bridgePeerNodeId?: string;
  bridgePeerRuntime?: string;
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
  unread?: number;
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
  options: DesktopAuthOption[];
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

export type DesktopChatMessage = {
  role: string;
  sender?: string | null;
  text: string;
  detail?: string | null;
  timeLabel: string;
  timestampMs: number;
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
};

export type DesktopBridgeProject = {
  id: string;
  name: string;
  memberCount: number;
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
  visiblePeers: DesktopBridgePeer[];
  visiblePeerCount: number;
  projects: DesktopBridgeProject[];
  lastError?: string | null;
};

export type DesktopBridgeConversationMessage = {
  id: string;
  direction: string;
  sender?: string | null;
  text: string;
  timeLabel: string;
  timestampMs: number;
  deliveryState?: string | null;
};

export type DesktopBridgeConversation = {
  id: string;
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
  messages: DesktopBridgeConversationMessage[];
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

export type DesktopChatState = {
  cwd: string;
  activeSessionId: string;
  sessions: DesktopChatSessionSummary[];
  projects: DesktopChatProjectGroup[];
  activeSession: DesktopChatSessionDetail;
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

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
  pinned?: boolean;
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
  localPath?: string | null;
  sizeBytes?: number | null;
};

export type MessageMention = {
  label: string;
  targetKind?: 'bridge-agent' | 'bridge-person' | string;
  bridgeHostId?: string | null;
  nodeId?: string | null;
  humanId?: string | null;
  agentId?: string | null;
};

export type MessageSourceReference = {
  messageId: string;
  senderLabel?: string | null;
  text: string;
  attachmentCount?: number;
  time?: string | null;
};

export type MessageReplySummary = {
  replyCount: number;
  pending: boolean;
  targetMessageId?: string | null;
};

export type Message = {
  id?: string;
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
  replyToMessageId?: string | null;
  replyAliasIds?: string[];
  replySummary?: MessageReplySummary;
  sourceMessage?: MessageSourceReference | null;
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

export type DesktopChatToolSnapshot = {
  id: string;
  name: string;
  status: string;
  arguments: string;
  liveOutput: string;
  resultText?: string | null;
  detail?: string | null;
  artifactPath?: string | null;
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

export type BridgeAgentRequestControl = {
  conversationId: string;
  requestId: string;
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
  transcriptRefreshRequired?: boolean;
  replyToMessageId?: string | null;
  sourceMessage?: MessageSourceReference | null;
  pendingBridgeAgentRequest?: BridgeAgentRequestControl | null;
};

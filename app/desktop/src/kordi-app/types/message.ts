import type { DesktopChatContextMessage, DesktopChatMessageRoute } from '@/lib/desktop';

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
  category?: 'artifact' | 'related' | 'memory';
  summary: string;
  timeLabel?: string;
  live?: boolean;
  pinned?: boolean;
};

export type ChangedFileRow = {
  path: string;
  status: 'new' | 'modified' | 'deleted';
  artifactId: string;
  diffStat?: { added: number; removed: number };
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
  subtype?: 'meme' | null;
  altText?: string | null;
  name: string;
  formatLabel?: string | null;
  previewUrl?: string | null;
  downloadUrl?: string | null;
  mimeType?: string | null;
  localPath?: string | null;
  sizeBytes?: number | null;
  attachmentId?: string | null;
  previewAttachmentId?: string | null;
};

export type DesktopChatAttachment = {
  kind: 'image' | 'file';
  subtype?: 'meme' | null;
  altText?: string | null;
  name: string;
  formatLabel?: string | null;
  previewUrl?: string | null;
  downloadUrl?: string | null;
  mimeType?: string | null;
  localPath?: string | null;
  sizeBytes?: number | null;
  attachmentId?: string | null;
};

export type MessageMention = {
  label: string;
  targetKind?: 'agent' | 'person' | string;
  sourceHostId?: string | null;
  nodeId?: string | null;
  humanId?: string | null;
  agentId?: string | null;
  displayLabel?: string | null;
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

export type MessageReadReceiptParticipant = {
  id: string;
  name: string;
  avatarSeed?: string | null;
  profileImageUrl?: string | null;
  readAt?: string | null;
};

export type MessageReadReceiptSummary = {
  count: number;
  participants: MessageReadReceiptParticipant[];
};

export type MessageActionSource = {
  sourceSessionId: string;
  sourceMessageId: string;
  sourceMessageKind?: string | null;
  senderLabel: string;
  textPreview: string;
  attachmentCount: number;
  createdAtMs?: number | null;
  timeLabel?: string | null;
};

export type MessageActionMetadata = {
  schemaVersion: 1;
  kind: 'quote' | 'forward';
  source: MessageActionSource;
};

export type MessageCallActivity = {
  callId: string;
  kind: 'voice' | 'video' | 'meeting';
  event: 'started' | 'ended';
  direction: 'incoming' | 'outgoing';
  outcome: 'ringing' | 'completed' | 'missed' | 'canceled' | 'ended';
  durationSeconds?: number | null;
};

export type ComposerQuoteState = {
  action: 'quote';
  source: MessageActionSource;
};

export type Message = {
  id?: string;
  /** Stable id of the canonical session entry rendered by this row,
   * including aggregated assistant turns. Required for actions like fork. */
  entryId?: string | null;
  role: 'system' | 'user' | 'owned-agent' | 'external-agent' | 'person' | 'action' | 'edit';
  sender?: string;
  /** Canonical human/agent identity for profile actions in shared transcripts. */
  senderIdentityId?: string | null;
  sourceSenderLabel?: string | null;
  senderType?: 'human' | 'agent';
  senderProfileImageUrl?: string | null;
  senderAvatarSeed?: string | null;
  isOwnMessage?: boolean;
  showSenderMeta?: boolean;
  /** Kordi Support answers are service responses presented as ordinary contact
   * messages. This preserves support-specific report actions without routing
   * the row through the live-agent turn UI. */
  supportContactResponse?: boolean;
  /** A pending Kordi Support response rendered as contact-style typing dots.
   * The underlying agent turn is intentionally removed from the presentation
   * model so the generic agent processing card cannot leak into this chat. */
  supportContactTyping?: boolean;
  text: string;
  time: string;
  /** Exact source timestamp used for transcript ordering and time separators.
   * Keep this value numeric instead of reconstructing it from the localized
   * `time` label. */
  timestampMs?: number | null;
  /** Structured call history metadata rendered as a dedicated call item rather
   * than a generic system notice or ordinary message bubble. */
  callActivity?: MessageCallActivity;
  detail?: string;
  statusChips?: string[];
  attachments?: MessageAttachment[];
  mentions?: MessageMention[];
  replyToMessageId?: string | null;
  replyAliasIds?: string[];
  replySummary?: MessageReplySummary;
  readReceiptSummary?: MessageReadReceiptSummary | null;
  messageAction?: MessageActionMetadata | null;
  sourceMessage?: MessageSourceReference | null;
  turn?: DesktopChatTurnSnapshot;
  edit?: {
    files: EditFilePreview[];
  };
  /** True for messages cloned from a canonical fork's source session
   * (everything before the first post-fork user message). Lets the
   * transcript draw a "Forked from conversation" divider between the
   * inherited snapshot and the user's own continuation. */
  isForkSnapshot?: boolean;
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
  toolLayer?: string | null;
  isError: boolean;
};

export type QueuedDesktopChatMessage = {
  id: string;
  sessionId: string;
  scope: 'chat' | 'project';
  text: string;
  time: string;
  attachments: (MessageAttachment & { id: string; path: string })[];
  contextMessages?: DesktopChatContextMessage[];
  runtimeRoute?: DesktopChatMessageRoute | null;
};

export type CollaborationAgentRequestControl = {
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
  startedAtMs?: number | null;
  completedAtMs?: number | null;
  transcriptEntryId?: string | null;
  error?: string | null;
  transcriptRefreshRequired?: boolean;
  replyToMessageId?: string | null;
  sourceMessage?: MessageSourceReference | null;
  pendingCollaborationAgentRequest?: CollaborationAgentRequestControl | null;
};

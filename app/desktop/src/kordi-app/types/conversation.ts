import type { ConversationType, ConversationParticipant, DesktopChatContextWindowStatus, ConversationCollaborationTarget, DesktopCollaborationOutreachMetadata, DesktopCollaborationIdentitySnapshot, OutreachThreadSummary } from '../types';
import type { SessionTaskActivity } from '../sessionTaskTypes';
import type { Message, SessionArtifact, QueuedDesktopChatMessage, DesktopChatTurnSnapshot, SessionStatusIndicator } from './message';

export type Conversation = {
  id: string;
  /** A shared execution resource rendered in the existing chat pane, not a channel. */
  agentSubsessionId?: string;
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
  canonicalMessageCount?: number; canonicalProjectionPending?: boolean;
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
  threadAttention?: import('@/features/cloud/threadAttention').ThreadAttention;
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

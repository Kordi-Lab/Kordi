import type {
  Conversation,
  ConversationCollaborationTarget,
  ConversationParticipant,
  Message,
  SessionTaskActivity,
} from '@/kordi-app/types';

export type CanonicalConversationLike = {
  id: string;
  supportTicketEnabled?: boolean;
  _updatedAtMs?: number;
  canonicalSessionId?: string;
  canonicalStoragePath?: string;
  canonicalParticipantCount?: number;
  canonicalMessageCount?: number;
  canonicalDelegatedExchangeCount?: number;
  taskActivities?: SessionTaskActivity[];
  canonicalContextSnapshotCount?: number;
  canonicalPresenceSummary?: string;
  desktopRuntimeBacked?: boolean;
  desktopRuntimeTranscriptLoaded?: boolean;
  canonicalParticipants?: ConversationParticipant[];
  collaborationTarget?: ConversationCollaborationTarget | null;
  collaborationUnreadByParentSessionId?: Record<string, number>;
  collaborationSources: string[];
  trust: string;
  outreach?: { parentSessionId?: string | null } | null;
  participantSpaceId?: string | null;
  directness?: string | null;
  statusIndicator?: Conversation['statusIndicator'];
  updatedAtLabel?: string;
  unread?: number;
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
  profileImageUrl?: string | null;
  participantProfileImageUrls?: Record<string, string | null>;
  name: string;
  subtitle: string;
  participants: string[];
  messages: Message[];
};

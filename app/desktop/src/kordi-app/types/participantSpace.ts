import type { Conversation, ConversationParticipant, SessionStatusIndicator } from '../types';

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
  groupAvatar?: import('@/features/chat/groupAvatar').GroupAvatarSnapshot | null;
  sessions: ParticipantSpaceSessionViewModel[];
  groupCreatorIdentityId?: string | null;
  groupAdminIdentityIds?: string[];
  /** All persisted membership sessions, including hidden legacy empty shells. */
  membershipSessionIds?: string[];
  /** Hidden persisted blank continuation that can be reused instead of creating another shell. */
  reusableBlankSessionId?: string | null;
};

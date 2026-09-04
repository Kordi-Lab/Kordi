import type { ParticipantSpaceViewModel } from '@/kordi-app/types';

export type ChatListShellArgs = {
  archivedParticipantSpaces: ParticipantSpaceViewModel[];
  pinnedChatSessionIds: ReadonlySet<string>;
  mutedChatSessionIds: ReadonlySet<string>;
  unreadChatSessionIds: ReadonlySet<string>;
  pinnedChatGroupSpaceIds: ReadonlySet<string>;
  handleRestoreChatSession: (sessionId: string) => Promise<void>;
  handleSetChatSessionPinned: (sessionId: string, pinned: boolean) => Promise<void>;
  handleSetChatSessionMuted: (sessionId: string, muted: boolean) => Promise<void>;
  handleSetChatSessionUnread: (sessionId: string, unread: boolean) => Promise<void>;
  handleMarkChatSessionsRead: (sessionIds: string[]) => Promise<void>;
  handleSetChatGroupPinned: (groupSpaceId: string, pinned: boolean) => Promise<void>;
  handleSetChatGroupMuted: (
    groupSpaceId: string,
    sessionIds: string[],
    muted: boolean,
  ) => Promise<void>;
  handleSetChatGroupArchived: (
    groupSpaceId: string,
    sessionIds: string[],
    archived: boolean,
  ) => Promise<void>;
};

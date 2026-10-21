import type { DesktopChatAttachment, DesktopChatToolSnapshot, MessageActionMetadata, MessageMention } from './message';

export type DesktopChatMessage = {
  role: string;
  sender?: string | null;
  text: string;
  detail?: string | null;
  timeLabel: string;
  timestampMs: number;
  failed?: boolean; error?: string | null; // A failed turn's failure, when `text` is its partial reply.
  cancelled?: boolean;
  attachments?: DesktopChatAttachment[];
  mentions?: MessageMention[];
  replyToMessageId?: string | null;
  messageAction?: MessageActionMetadata | null;
  thinkingText?: string | null;
  segments?: import('@/features/chat/turnSegments').TurnSegment[];
  tools?: DesktopChatToolSnapshot[];
  turnStartedAtMs?: number | null;
  turnCompletedAtMs?: number | null;
  transcriptRenderId?: string | null; // Ephemeral renderer identity; never persisted.
  /** Stable id of the underlying session entry; only set for messages
   * that map 1:1 to a SessionEntry (e.g., user messages). */
  entryId?: string | null;
};

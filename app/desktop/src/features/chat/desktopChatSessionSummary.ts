export type DesktopChatSessionSummary = {
  id: string;
  title: string;
  subtitle: string;
  updatedAtLabel: string;
  updatedAtMs: number;
  messageCount: number;
  draft: boolean;
  backgroundStatus?: string | null;
  forkedFromSessionId?: string | null;
  forkedFromMessageId?: string | null;
};

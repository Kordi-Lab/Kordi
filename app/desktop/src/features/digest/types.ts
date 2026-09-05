export type DigestSource = {
  id: string; conversationId: string; sessionId: string; sessionTitle: string;
  senderAccountId: string; senderName: string; text: string; createdAt: string; version: number; isAgent?: boolean;
};
export type DigestItem = {
  id: string; title: string; text: string; kind: string; sourceIds: string[];
  ownerAccountId?: string | null; dueAt?: string | null; existingTaskId?: string | null;
  startAt?: string | null; endAt?: string | null;
};
export type DigestSnapshot = { claims: DigestItem[]; commitments: DigestItem[]; suggestions: DigestItem[]; calendarCandidates: DigestItem[] };
export type DigestResponse = {
  accountId: string; snapshot: DigestSnapshot | null; sources: DigestSource[];
  partial: boolean; revision: number; updatedAt: string;
  status: 'ready' | 'loading' | 'updating' | 'error'; errorCode?: string | null;
  feedback: { id: string; status: 'dismissed' | 'task'; taskId?: string | null }[];
};
export type CalendarEvent = {
  id: string; title: string; startAt: string; endAt?: string | null; reminderAt?: string | null;
  allDay: boolean; sourceIds: string[]; description: string; externalUid?: string | null; revision: number;
};
export type CalendarConnection = { id: string; title: string; color?: string };

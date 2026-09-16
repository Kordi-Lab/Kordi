export type DigestSource = {
  id: string; conversationId: string; sessionId: string; sessionTitle: string;
  senderAccountId: string; senderName: string; text: string; createdAt: string; version: number; isAgent?: boolean;
  agentId?: string | null; agentOwnerName?: string | null; agentAvatarUrl?: string | null;
  senderAvatarUrl?: string | null;
  replyToSourceId?: string | null;
};
export type DigestItem = {
  id: string; title: string; text: string; kind: string; sourceIds: string[];
  ownerAccountId?: string | null; dueAt?: string | null; existingTaskId?: string | null;
  startAt?: string | null; endAt?: string | null;
  timezone?: string | null;
  calendarAction?: 'create' | 'update' | 'delete' | null;
  existingEventId?: string | null; existingEventRevision?: number | null;
  calendarScope?: 'occurrence' | 'series' | null; existingSeriesId?: string | null;
  recurrence?: CalendarRecurrence | null;
};
export type DigestSnapshot = { claims: DigestItem[]; commitments: DigestItem[]; suggestions: DigestItem[]; calendarCandidates: DigestItem[] };
export type DigestResponse = {
  accountId: string; snapshot: DigestSnapshot | null; sources: DigestSource[];
  partial: boolean; revision: number; updatedAt: string;
  timezone?: string;
  status: 'ready' | 'loading' | 'updating' | 'error'; errorCode?: string | null;
  feedback: { id: string; status: 'dismissed' | 'task'; taskId?: string | null }[];
};
export type CalendarEvent = {
  id: string; title: string; startAt: string; endAt?: string | null; reminderAt?: string | null;
  allDay: boolean; sourceIds: string[]; description: string; externalUid?: string | null; revision: number;
  links?: string[] | null;
  timezone?: string | null;
  recurrence?: CalendarRecurrence | null; seriesId?: string | null; seriesFingerprint?: string | null;
  confirmSingleOccurrence?: boolean;
  /** Server write time, read-only. Used to settle edits made on both sides between syncs. */
  updatedAt?: string | null;
};
/** An event read from the device calendar store. `externalUid` is the stable device identity. */
export type DeviceCalendarEvent = CalendarEvent & { externalUid: string; deviceId: string; calendarId: string; modifiedAt?: string | null };
export type DeviceCalendarAccess = 'granted' | 'writeOnly' | 'denied' | 'restricted' | 'notDetermined' | 'unavailable';
export type CalendarSyncResult = { saved: CalendarEvent[]; conflicts: string[]; skipped: string[]; deleted: string[]; deleteConflicts: string[]; capacity: number };
export type CalendarRecurrence = { frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval: number; weekdays: number[]; timezone: string; count?: number | null; until?: string | null };
export type CalendarConnection = { id: string; title: string; color?: string; allowsModifications?: boolean };

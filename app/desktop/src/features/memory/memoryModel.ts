import type { MemoryCategory, MemoryConfidence, MemoryDeclarationType, MemoryProfileKind } from './memoryCategory';

export type MemoryLessonScope = 'global' | 'conversation' | 'project' | 'group';
export type MemoryLessonSource = 'user_correction' | 'repeated_failure' | 'outcome' | 'manual';

export type MemoryLesson = {
  lessonId: string;
  scope: MemoryLessonScope;
  scopeId: string;
  scopeLabel: string;
  source: MemoryLessonSource;
  text: string;
  createdAt: string;
  updatedAt: string;
  /** The account that saved the memory; absent for memories read from this Mac. */
  ownerAccountId?: string;
  ownerName?: string | null;
  /** Routing fields from servers with categories; absent for memories read from this Mac. */
  category?: MemoryCategory;
  declarationType?: MemoryDeclarationType;
  confidence?: MemoryConfidence | null;
  profileId?: string | null;
  profileKind?: MemoryProfileKind | null;
};

export type MemorySettings = { lessonsEnabled: boolean; excludeSensitive: boolean };

/** Where a memory typed on a Memory page is saved: the scope of the page it was added from. */
export type MemoryAddTarget = { scope: MemoryLessonScope; scopeId: string; scopeLabel?: string | null };

/** Account settings add global memories, which always use the `account` scope id. */
export const GLOBAL_MEMORY_TARGET: MemoryAddTarget = { scope: 'global', scopeId: 'account' };

export const LESSON_MAX_CHARS = 500;

const sourceLabels: Record<MemoryLessonSource, string> = {
  user_correction: 'From a correction',
  repeated_failure: 'From a repeated failure',
  outcome: 'From an outcome',
  manual: 'Added by you',
};

/** A memory someone typed names who added it; the others name where they came from. */
export function lessonSourceLabel(source: MemoryLessonSource, addedBy?: string | null): string {
  if (source !== 'manual') return sourceLabels[source];
  const name = addedBy?.trim();
  return name ? `Added by ${name}` : 'Added by you';
}

/**
 * The meta label of a memory row. The declaration type wins over the source: a memory the agent
 * inferred reads "Saved by your agent" (or "Saved by <member>" for another member's agent), with its
 * confidence, even when the agent passed source `manual`. Otherwise the source decides.
 */
export function lessonOriginLabel(
  lesson: Pick<MemoryLesson, 'source' | 'ownerAccountId' | 'ownerName' | 'declarationType' | 'confidence'>,
  viewerAccountId: string | null | undefined,
): string {
  const addedBy = memoryAddedBy(lesson, viewerAccountId);
  if (lesson.declarationType !== 'model-inferred') return lessonSourceLabel(lesson.source, addedBy);
  const who = isOwnMemory(lesson, viewerAccountId) ? 'your agent' : addedBy ?? 'a group member';
  return lesson.confidence ? `Saved by ${who} \u00b7 ${lesson.confidence} confidence` : `Saved by ${who}`;
}

/** Account settings list only global memories; the rest show on each conversation's Memory tab. */
export function isGlobalMemory(lesson: Pick<MemoryLesson, 'scope'>): boolean {
  return lesson.scope === 'global';
}

export const NOT_A_GROUP_MEMBER_MESSAGE = 'Only group members can change this memory.';

/** Whether the viewer saved the memory. Memories without an owner are the viewer's own. */
export function isOwnMemory(lesson: Pick<MemoryLesson, 'ownerAccountId'>, viewerAccountId: string | null | undefined): boolean {
  return !lesson.ownerAccountId || !viewerAccountId || lesson.ownerAccountId === viewerAccountId;
}

/** Who to name for a memory typed by hand: the owner's name, nothing ("you") for the viewer's own, or "a group member". */
export function memoryAddedBy(
  lesson: Pick<MemoryLesson, 'ownerAccountId' | 'ownerName'>,
  viewerAccountId: string | null | undefined,
): string | null {
  const name = lesson.ownerName?.trim();
  if (name) return name;
  return isOwnMemory(lesson, viewerAccountId) ? null : 'a group member';
}

/** "Saved by …" for a group memory another member saved, otherwise null. */
export function memoryOwnerCaption(
  lesson: Pick<MemoryLesson, 'scope' | 'ownerAccountId' | 'ownerName'> & Partial<Pick<MemoryLesson, 'source' | 'declarationType'>>,
  viewerAccountId: string | null | undefined,
): string | null {
  if (lesson.scope !== 'group' || isOwnMemory(lesson, viewerAccountId)) return null;
  // An inferred memory already names who saved it in its origin label.
  if ('declarationType' in lesson && lesson.declarationType === 'model-inferred') return null;
  // A memory typed by hand already names who added it in its source label.
  if ('source' in lesson && lesson.source === 'manual') return null;
  return `Saved by ${lesson.ownerName?.trim() || 'a group member'}`;
}

const lessonDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function lessonDateLabel(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(date.getTime())) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return lessonDateFormatter.format(date);
}

export type LessonTextValidation = { ok: true; text: string } | { ok: false; reason: string };

export function validateLessonText(text: string): LessonTextValidation {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return { ok: false, reason: 'Enter a memory.' };
  if (normalized.length > LESSON_MAX_CHARS) return { ok: false, reason: `Memories are ${LESSON_MAX_CHARS} characters or fewer.` };
  return { ok: true, text: normalized };
}

export function memoryErrorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

export function forgetConsequences(count: number): string {
  const memories = count === 1 ? '1 memory' : `${count} memories`;
  return `This deletes ${memories} from your account and every signed-in device. It cannot be undone.`;
}

export type MemorySyncState = { accountLabel: string; lastSyncedAt: string | null };

/** Describes which account the memories sync with and how recently they synced. */
export function syncStatusLabel(state: MemorySyncState, now: number = Date.now()): string {
  if (state.lastSyncedAt === null) return `Not synced yet with ${state.accountLabel}`;
  const elapsed = now - new Date(state.lastSyncedAt).getTime();
  let when: string;
  if (elapsed < 60_000) {
    when = 'just now';
  } else if (elapsed < 3_600_000) {
    const minutes = Math.floor(elapsed / 60_000);
    when = minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  } else {
    when = lessonDateLabel(state.lastSyncedAt, now);
  }
  return `Synced with ${state.accountLabel} · ${when}`;
}

export type MemoryLessonScope = 'conversation' | 'project' | 'group';
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
};

export type MemorySettings = { lessonsEnabled: boolean; excludeSensitive: boolean };

export type MemoryReplayState = { available: boolean; runCount: number };

export const LESSON_MAX_CHARS = 500;

const scopeOrder: MemoryLessonScope[] = ['conversation', 'project', 'group'];

const sourceLabels: Record<MemoryLessonSource, string> = {
  user_correction: 'From a correction',
  repeated_failure: 'From a repeated failure',
  outcome: 'From an outcome',
  manual: 'Added by hand',
};

const scopeGroupLabels: Record<MemoryLessonScope, string> = {
  conversation: 'Conversations',
  project: 'Projects',
  group: 'Groups',
};

export function lessonSourceLabel(source: MemoryLessonSource): string {
  return sourceLabels[source];
}

export function lessonScopeGroupLabel(scope: MemoryLessonScope): string {
  return scopeGroupLabels[scope];
}

export type MemoryLessonGroup = { scope: MemoryLessonScope; label: string; lessons: MemoryLesson[] };

/** Personal memories: the settings page lists these; groups list theirs on the group info page. */
export const PERSONAL_MEMORY_SCOPES: readonly MemoryLessonScope[] = ['conversation', 'project'];

/** Groups memories by scope in a fixed order, newest first, without empty groups. */
export function groupLessonsByScope(
  lessons: MemoryLesson[],
  scopes: readonly MemoryLessonScope[] = scopeOrder,
): MemoryLessonGroup[] {
  return scopeOrder
    .filter((scope) => scopes.includes(scope))
    .map((scope) => ({
      scope,
      label: lessonScopeGroupLabel(scope),
      lessons: lessons
        .filter((lesson) => lesson.scope === scope)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
    .filter((group) => group.lessons.length > 0);
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

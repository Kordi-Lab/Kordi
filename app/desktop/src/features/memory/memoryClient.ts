import { createAccountMemoryClient } from './accountMemoryClient';
import {
  validateLessonText,
  type MemoryLesson,
  type MemorySettings,
  type MemorySyncState,
} from './memoryModel';

export type MemoryClient = {
  settings(): Promise<MemorySettings>;
  updateSettings(patch: Partial<MemorySettings>): Promise<MemorySettings>;
  listLessons(): Promise<MemoryLesson[]>;
  updateLesson(lessonId: string, text: string): Promise<MemoryLesson>;
  archiveLesson(lessonId: string): Promise<void>;
  forgetAll(): Promise<{ archived: number }>;
  /** Which account the memories sync with and when they were last synced. */
  syncState(): Promise<MemorySyncState>;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(now: number, ms: number): string {
  return new Date(now - ms).toISOString();
}

/** Group uuid of the sample group memory; the cloud runner stores group memories under the bare uuid. */
export const PREVIEW_GROUP_MEMORY_SCOPE_ID = '4f1c2a9e-7d3b-4e8a-9c61-2b5d8e0f3a17';

export type PreviewMemoryClientOptions = {
  /** Simulated network latency in milliseconds. */
  latencyMs?: number;
  now?: () => number;
  /** The account the sample memories appear to sync with. */
  accountLabel?: string;
};

/**
 * In-memory memory client with sample memories. It only models what the
 * settings page shows and never reads memory on this Mac or the server.
 */
export function createPreviewMemoryClient(options: PreviewMemoryClientOptions = {}): MemoryClient {
  const latencyMs = options.latencyMs ?? 400;
  const now = options.now ?? Date.now;
  const seededAt = now();
  const accountLabel = options.accountLabel ?? 'taylor@memory.example';
  let lastSyncedAt: string | null = null;
  const markSynced = () => { lastSyncedAt = new Date(now()).toISOString(); };

  const lesson = (
    lessonId: string,
    scope: MemoryLesson['scope'],
    scopeId: string,
    scopeLabel: string,
    source: MemoryLesson['source'],
    text: string,
    ageMs: number,
  ): MemoryLesson => {
    const at = ago(seededAt, ageMs);
    return { lessonId, scope, scopeId, scopeLabel, source, text, createdAt: at, updatedAt: at };
  };

  let settings: MemorySettings = { lessonsEnabled: true, excludeSensitive: true };
  let lessons: MemoryLesson[] = [
    lesson('lesson-1', 'conversation', 'conv-launch-copy', 'Launch copy with Priya', 'user_correction',
      'Keep launch headlines under eight words and write them in sentence case, not title case.', 2 * HOUR),
    lesson('lesson-2', 'conversation', 'conv-launch-copy', 'Launch copy with Priya', 'outcome',
      'Priya approved the second draft once the pricing line moved below the feature list. Lead with what the product does.', 3 * DAY),
    lesson('lesson-3', 'conversation', 'conv-weekly-planning', 'Weekly planning', 'manual',
      'Plan the week on Monday mornings and list at most three priorities, each with one owner.', DAY + 2 * HOUR),
    lesson('lesson-4', 'conversation', 'conv-weekly-planning', 'Weekly planning', 'user_correction',
      'Do not move unfinished tasks to the next week automatically. Ask which ones still matter first.', 12 * DAY),
    lesson('lesson-5', 'project', 'proj-launch-site', '~/Projects/launch-site', 'repeated_failure',
      'The site build fails when images are added without width and height. Set both before running the build again.', 5 * DAY),
    lesson('lesson-6', 'project', 'proj-kordi-plugins', '~/Projects/kordi-plugins', 'outcome',
      'Plugin tests pass only after the sample config is copied into the test folder. Copy it before the first run.', 21 * DAY),
    lesson('lesson-7', 'group', PREVIEW_GROUP_MEMORY_SCOPE_ID, 'Design review', 'repeated_failure',
      'Share screenshots as attachments instead of links. Several members could not open the shared folder links.', 40 * DAY),
  ];

  const wait = () => new Promise<void>((resolve) => { setTimeout(resolve, latencyMs); });
  const copyLessons = () => lessons.map((entry) => ({ ...entry }));

  return {
    async settings() {
      await wait();
      return { ...settings };
    },
    async updateSettings(patch) {
      await wait();
      settings = { ...settings, ...patch };
      markSynced();
      return { ...settings };
    },
    async listLessons() {
      await wait();
      return copyLessons();
    },
    async updateLesson(lessonId, text) {
      await wait();
      const validation = validateLessonText(text);
      if (!validation.ok) throw new Error(validation.reason);
      const existing = lessons.find((entry) => entry.lessonId === lessonId);
      if (!existing) throw new Error('This memory no longer exists.');
      const updated = { ...existing, text: validation.text, updatedAt: new Date(now()).toISOString() };
      lessons = lessons.map((entry) => (entry.lessonId === lessonId ? updated : entry));
      markSynced();
      return { ...updated };
    },
    async archiveLesson(lessonId) {
      await wait();
      lessons = lessons.filter((entry) => entry.lessonId !== lessonId);
      markSynced();
    },
    async forgetAll() {
      await wait();
      const archived = lessons.length;
      lessons = [];
      markSynced();
      return { archived };
    },
    async syncState() {
      await wait();
      return { accountLabel, lastSyncedAt: lastSyncedAt ?? new Date(now() - 2 * MINUTE).toISOString() };
    },
  };
}

function isPreviewFlag(flag: string | undefined): boolean {
  return flag === '1' || flag === 'true';
}

export function memoryClientForFlag(flag: string | undefined): MemoryClient | null {
  return isPreviewFlag(flag) ? createPreviewMemoryClient() : null;
}

function memoryPreviewFlag(): string | undefined {
  // `import.meta.env` is undefined outside Vite (for example under tsx tests).
  const flag: unknown = import.meta.env?.VITE_KORDI_MEMORY_PREVIEW;
  return typeof flag === 'string' ? flag : undefined;
}

let environmentMemoryClient: MemoryClient | null = null;

/**
 * Returns the memory client for this build: the preview client when the
 * preview flag is set, otherwise the client backed by the account memory routes.
 * It is created once per app load so its state survives closing the dialog.
 */
export function memoryClientForEnvironment(): MemoryClient {
  environmentMemoryClient ??= memoryClientForFlag(memoryPreviewFlag()) ?? createAccountMemoryClient();
  return environmentMemoryClient;
}

/**
 * The Memory section shows when the server advertises memory routes through
 * `memoryVersion`, or always when the preview flag is set.
 */
export function memorySectionAvailable(memoryVersion: number | null | undefined): boolean {
  return Boolean(memoryVersion) || isPreviewFlag(memoryPreviewFlag());
}

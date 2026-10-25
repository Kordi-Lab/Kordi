// Where a memory came from, by name: the chat title, the project name, the group title or "Global".
// Chat and group names come from the canonical sessions and the chat sync conversations on this Mac;
// the label saved with the memory is the fallback.

import type { ChatSyncConversation } from '@/features/cloud/chatSyncTypes';
import { fetchCanonicalSessionCatalog } from '@/lib/desktop';
import { loadChatSyncConversations } from '@/lib/desktopChatSync';
import type { CanonicalSession } from '@/kordi-app/types';

import type { MemoryLesson, MemoryLessonScope } from './memoryModel';

const GROUP_SESSION_PREFIX = 'session:group:';

export type MemoryOriginSession = Pick<CanonicalSession, 'id' | 'title'> & Partial<Pick<CanonicalSession, 'projectId' | 'projectName'>>;
export type MemoryOriginConversation = Pick<ChatSyncConversation, 'id' | 'kind' | 'legacy_session_id' | 'shared_title'>
  & Partial<Pick<ChatSyncConversation, 'group_title'>>;

/** The chats and groups the app knows, to name memory origins. */
export type MemoryOriginSources = {
  sessions: readonly MemoryOriginSession[];
  conversations: readonly MemoryOriginConversation[];
};

export const NO_ORIGIN_SOURCES: MemoryOriginSources = { sessions: [], conversations: [] };

export type MemoryOrigin = { key: string; label: string };

// The account client fills a missing scope label with these words; they name no chat.
const PLACEHOLDER_LABELS: Record<MemoryLessonScope, string> = {
  global: 'Global',
  conversation: 'Conversation',
  project: 'Project',
  group: 'Group',
};

function text(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function savedLabel(lesson: Pick<MemoryLesson, 'scope' | 'scopeLabel'>): string {
  const label = text(lesson.scopeLabel);
  return label === PLACEHOLDER_LABELS[lesson.scope] ? '' : label;
}

/** The last segment of a path such as `~/Projects/site`; other text as is. */
export function lastPathSegment(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  if (!/[\\/]/.test(trimmed)) return trimmed;
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
}

function conversationTitle(lesson: MemoryLesson, sources: MemoryOriginSources): string {
  const id = lesson.scopeId.trim();
  const session = sources.sessions.find((entry) => entry.id === id);
  if (text(session?.title)) return text(session?.title);
  const row = sources.conversations.find((entry) => entry.id === id || entry.legacy_session_id === id);
  return text(row?.shared_title);
}

function projectName(lesson: MemoryLesson, sources: MemoryOriginSources): string {
  const id = lesson.scopeId.trim();
  const named = sources.sessions.find((entry) => entry.projectId === id && text(entry.projectName));
  if (named) return text(named.projectName);
  const label = savedLabel(lesson);
  return lastPathSegment(label || id);
}

function groupTitle(lesson: MemoryLesson, sources: MemoryOriginSources): string {
  const id = lesson.scopeId.trim();
  const row = sources.conversations.find((entry) => entry.id === id);
  const fromRow = text(row?.group_title) || text(row?.shared_title);
  if (fromRow) return fromRow;
  // Older writers stored the local group id; the local session id adds the group prefix.
  const localIds = [row?.legacy_session_id, id, `${GROUP_SESSION_PREFIX}${id}`].map((value) => value?.trim()).filter(Boolean);
  const session = sources.sessions.find((entry) => localIds.includes(entry.id));
  return text(session?.title);
}

/** The origin label of a memory and the filter key that groups memories of the same origin. */
export function memoryOrigin(lesson: MemoryLesson, sources: MemoryOriginSources): MemoryOrigin {
  const key = lesson.scope === 'global' ? 'global' : `${lesson.scope}:${lesson.scopeId.trim()}`;
  switch (lesson.scope) {
    case 'global':
      return { key, label: 'Global' };
    case 'conversation':
      return { key, label: conversationTitle(lesson, sources) || savedLabel(lesson) || 'Chat' };
    case 'project':
      return { key, label: projectName(lesson, sources) || 'Project' };
    case 'group':
      return { key, label: groupTitle(lesson, sources) || savedLabel(lesson) || 'Group' };
  }
}

/** Reads the chats and groups on this Mac; outside the native shell, or on failure, there are none. */
export async function loadMemoryOriginSources(accountId: string | null | undefined): Promise<MemoryOriginSources> {
  const [catalog, conversations] = await Promise.all([
    fetchCanonicalSessionCatalog().catch(() => null),
    accountId ? loadChatSyncConversations(accountId).catch(() => []) : Promise.resolve([]),
  ]);
  return { sessions: catalog?.sessions ?? [], conversations };
}

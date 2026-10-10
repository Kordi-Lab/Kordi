import type { MemoryLesson } from './memoryModel';

const SPACE_PREFIX = 'group:';
const GROUP_SESSION_PREFIX = 'session:group:';

type MaybeId = string | null | undefined;

/** The scope ids whose memories belong to one chat, per scope. */
export type ConversationMemoryScopes = {
  conversation: string[];
  group: string[];
  project: string[];
};

export type ConversationMemoryScopeInput = {
  /**
   * The chat's session ids: the canonical session id first, then the
   * conversation id and an agent subsession id. The Mac agent and the cloud
   * runner both save conversation memories under the canonical session id
   * (the cloud `sessionId`), and the runner also accepts the subsession id.
   */
  sessionIds: readonly MaybeId[];
  /** The participant space id of a group chat (`group:<session id>`). */
  participantSpaceId?: MaybeId;
  /** The project root path the Mac saves project memories under, plus the chat project id. */
  projectIds?: readonly MaybeId[];
};

function present(values: readonly MaybeId[]): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? '').filter(Boolean))];
}

function groupIdForms(value: string): string[] {
  const spaceless = value.startsWith(SPACE_PREFIX) ? value.slice(SPACE_PREFIX.length) : value;
  if (!spaceless.startsWith(GROUP_SESSION_PREFIX)) return [];
  const bare = spaceless.slice(GROUP_SESSION_PREFIX.length);
  return bare ? [value, spaceless, bare] : [];
}

/**
 * Every scope id a memory of this chat may be stored under. A group memory
 * uses the group id: the group session id with `session:group:` stripped. The
 * full session id and the space id are accepted too, as older writers used them.
 */
export function conversationMemoryScopes(input: ConversationMemoryScopeInput): ConversationMemoryScopes {
  const sessionIds = present(input.sessionIds);
  return {
    conversation: sessionIds,
    group: present([...sessionIds, input.participantSpaceId].flatMap((id) => (id ? groupIdForms(id.trim()) : []))),
    project: present(input.projectIds ?? []),
  };
}

/** Whether a memory belongs to the chat. Global memories never do; they live in account settings. */
export function isMemoryForConversation(
  memory: Pick<MemoryLesson, 'scope' | 'scopeId'>,
  scopes: ConversationMemoryScopes,
): boolean {
  if (memory.scope === 'global') return false;
  const scopeId = memory.scopeId.trim();
  return Boolean(scopeId) && scopes[memory.scope].includes(scopeId);
}

import { participantSpaceCanonicalMembershipSessionIds } from '@/features/chat/chatCreateFlows';
import type { ParticipantSpaceViewModel } from '@/kordi-app/types';

import type { MemoryLesson } from './memoryModel';

const SPACE_PREFIX = 'group:';
const GROUP_SESSION_PREFIX = 'session:group:';

function idForms(value: string): string[] {
  const full = value.trim();
  if (!full) return [];
  const spaceless = full.startsWith(SPACE_PREFIX) ? full.slice(SPACE_PREFIX.length) : full;
  const bare = spaceless.startsWith(GROUP_SESSION_PREFIX) ? spaceless.slice(GROUP_SESSION_PREFIX.length) : spaceless;
  return [full, spaceless, bare].filter(Boolean);
}

/**
 * Every id a memory for this group may be stored under. The cloud runner
 * stores the group uuid without the `session:group:` prefix, while other
 * writers may use the group space id or a full membership session id.
 */
export function groupMemoryScopeIds(space: ParticipantSpaceViewModel): string[] {
  const sessionIds = participantSpaceCanonicalMembershipSessionIds(space);
  return [...new Set([space.id, ...sessionIds].flatMap(idForms))];
}

export function isMemoryForGroup(memory: Pick<MemoryLesson, 'scope' | 'scopeId'>, scopeIds: readonly string[]): boolean {
  if (memory.scope !== 'group') return false;
  const scopeId = memory.scopeId.trim();
  return Boolean(scopeId) && scopeIds.includes(scopeId);
}

import type { Conversation } from '@/kordi-app/types';
import type { ChatSidebarRow } from '@/pages/sidebar/chatSidebarRows';
import { sidebarSessionMatchesSearch } from '@/pages/sidebar/sidebarSessionSearch';
import { personalAgentEntryForConversation } from './personalAgentEntries';
import type { PersonalAgentEntry } from './personalAgentStore';

type SessionRow = {
  session: { id: string; canonicalSessionId?: string | null; title: string; preview: string; conversation: Conversation };
  space: { title: string; participants: ReadonlyArray<{ name: string }> };
};

export const PERSONAL_AGENT_ROW_KEY_PREFIX = 'personal:';

/** The sidebar row height of a personal agent: avatar, name and preview. */
const PERSONAL_AGENT_ROW_HEIGHT = 50;

/**
 * The Personal agent section from every sidebar session (unfiltered): one row
 * per agent in the server list, plus marked sessions the list does not name
 * yet, joined with the local session when this Mac has it. `sessionIds` are
 * kept out of every other section, whether or not the agent is loaded. While
 * searching, a row stays when its session matches like any other sidebar
 * session, or when the agent's name matches.
 */
export function personalAgentSidebarRows(
  entries: readonly PersonalAgentEntry[],
  sessionRows: ReadonlyMap<string, SessionRow>,
  search = '',
) {
  const sessionIds = new Set(entries.flatMap((entry) => [entry.sessionId, entry.conversationId].filter(Boolean)));
  const listed = new Map(entries.map((entry) => [entry.agentId, entry]));
  const local = new Map<string, { entry: PersonalAgentEntry; sessionId: string }>();
  for (const [sessionId, row] of sessionRows) {
    const { conversation } = row.session;
    // The match also names an agent the local list does not hold, from the conversation.
    const entry = personalAgentEntryForConversation(entries, {
      ...conversation, id: conversation.id || row.session.id,
      canonicalSessionId: row.session.canonicalSessionId ?? conversation.canonicalSessionId,
    });
    if (!entry) continue;
    sessionIds.add(sessionId);
    if (!local.has(entry.agentId) || sessionId === entry.sessionId) local.set(entry.agentId, { entry, sessionId });
  }
  const query = search.trim().toLowerCase();
  const entriesByAgentId = new Map<string, PersonalAgentEntry>();
  const agentIds = [...listed.keys(), ...[...local.keys()].filter((agentId) => !listed.has(agentId))];
  const rows: ChatSidebarRow[] = agentIds.flatMap((agentId) => {
    const found = local.get(agentId);
    const entry = found?.entry ?? listed.get(agentId)!;
    const sessionId = found?.sessionId ?? entry.sessionId;
    const row = sessionRows.get(sessionId);
    if (query && !entry.name.toLowerCase().includes(query) && !(row && sidebarSessionMatchesSearch(row, query))) return [];
    entriesByAgentId.set(agentId, entry);
    return [{
      kind: 'session', key: `${PERSONAL_AGENT_ROW_KEY_PREFIX}${agentId}`, sessionId, spaceId: 'personal',
      depth: 0, activePath: false, estimatedHeight: PERSONAL_AGENT_ROW_HEIGHT,
    }];
  });
  return { rows, sessionIds, entriesByAgentId };
}

export function personalAgentIdFromRowKey(key: string) {
  return key.startsWith(PERSONAL_AGENT_ROW_KEY_PREFIX) ? key.slice(PERSONAL_AGENT_ROW_KEY_PREFIX.length) : null;
}

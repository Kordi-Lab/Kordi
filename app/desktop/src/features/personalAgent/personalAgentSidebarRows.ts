import type { ChatSidebarRow } from '@/pages/sidebar/chatSidebarRows';
import { personalAgentEntryForConversation } from './personalAgentEntries';
import type { PersonalAgentEntry } from './personalAgentStore';

type SessionRow = {
  session: { id: string; canonicalSessionId?: string | null; title: string; preview: string; conversation: { id: string; canonicalSessionId?: string | null; metadata?: unknown } };
};

export const PERSONAL_AGENT_ROW_KEY_PREFIX = 'personal:';

/** The sidebar row height of a personal agent: avatar, name and preview. */
const PERSONAL_AGENT_ROW_HEIGHT = 50;

/**
 * The Personal agent section: one row per entry, joined with its local
 * session when this Mac has it, and the session ids the other sections skip.
 * While searching, only agents whose name or preview matches stay.
 */
export function personalAgentSidebarRows(
  entries: readonly PersonalAgentEntry[],
  sessionRows: ReadonlyMap<string, SessionRow>,
  search = '',
) {
  const sessionIdByAgentId = new Map<string, string>();
  const sessionIds = new Set<string>();
  for (const [sessionId, row] of sessionRows) {
    const entry = personalAgentEntryForConversation(entries, row.session.conversation)
      ?? personalAgentEntryForConversation(entries, { id: row.session.id, canonicalSessionId: row.session.canonicalSessionId });
    if (!entry) continue;
    sessionIds.add(sessionId);
    if (!sessionIdByAgentId.has(entry.agentId) || sessionId === entry.sessionId) sessionIdByAgentId.set(entry.agentId, sessionId);
  }
  const query = search.trim().toLowerCase();
  const rows: ChatSidebarRow[] = entries.flatMap((entry) => {
    const sessionId = sessionIdByAgentId.get(entry.agentId) ?? entry.sessionId;
    const preview = sessionRows.get(sessionId)?.session.preview ?? '';
    if (query && ![entry.name, preview].join(' ').toLowerCase().includes(query)) return [];
    return [{
      kind: 'session', key: `${PERSONAL_AGENT_ROW_KEY_PREFIX}${entry.agentId}`, sessionId, spaceId: 'personal',
      depth: 0, activePath: false, estimatedHeight: PERSONAL_AGENT_ROW_HEIGHT,
    }];
  });
  return { rows, sessionIds };
}

export function personalAgentIdFromRowKey(key: string) {
  return key.startsWith(PERSONAL_AGENT_ROW_KEY_PREFIX) ? key.slice(PERSONAL_AGENT_ROW_KEY_PREFIX.length) : null;
}

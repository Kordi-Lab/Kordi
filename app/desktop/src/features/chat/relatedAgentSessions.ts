import type { DesktopChatToolSnapshot } from '@/kordi-app/types';

const BACKGROUND_SESSION_PREFIX = 'Background session: ';
const MAX_RELATED_SESSIONS = 4;

function cleanText(value: unknown, maxLength: number) {
  return typeof value === 'string'
    ? value.trim().slice(0, maxLength)
    : '';
}

export type RelatedAgentSession = {
  sessionId: string;
  turnId?: string;
  title: string;
  status: string;
};

function parseBackgroundSession(resultText?: string | null): RelatedAgentSession | null {
  const line = resultText
    ?.split(/\r?\n/)
    .find((candidate) => candidate.startsWith(BACKGROUND_SESSION_PREFIX));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(BACKGROUND_SESSION_PREFIX.length)) as Record<string, unknown>;
    const sessionId = cleanText(parsed.sessionId, 256);
    const title = cleanText(parsed.title, 80);
    if (!sessionId || !title) return null;
    const turnId = cleanText(parsed.turnId, 256);
    return {
      sessionId,
      ...(turnId ? { turnId } : {}),
      title,
      status: cleanText(parsed.status, 32) || 'running',
    };
  } catch {
    return null;
  }
}

export function relatedAgentSessionsFromTools(
  tools: readonly DesktopChatToolSnapshot[] | null | undefined,
): RelatedAgentSession[] {
  const sessions = new Map<string, RelatedAgentSession>();
  for (const tool of tools ?? []) {
    if (tool.isError || tool.name.trim().toLowerCase() !== 'task_operator') continue;
    const session = parseBackgroundSession(tool.resultText);
    if (!session || sessions.has(session.sessionId)) continue;
    sessions.set(session.sessionId, session);
    if (sessions.size >= MAX_RELATED_SESSIONS) break;
  }
  return [...sessions.values()];
}

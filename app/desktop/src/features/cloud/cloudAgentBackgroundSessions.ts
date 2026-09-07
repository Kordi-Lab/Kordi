import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import type { CloudAgentExecutionTool } from './cloudAgentExecutionSnapshot';

export type CloudAgentBackgroundSession = {
  sessionId: string;
  turnId?: string;
  title: string;
  summary?: string;
  status: string;
};

export function cloudAgentBackgroundSessionsFromTurn(
  turn: Pick<DesktopChatTurnSnapshot, 'tools'>,
): CloudAgentBackgroundSession[] {
  const sessions: CloudAgentBackgroundSession[] = [];
  for (const tool of turn.tools) {
    if (tool.isError || tool.name.trim().toLowerCase() !== 'task_operator') continue;
    const line = tool.resultText
      ?.split(/\r?\n/)
      .find((candidate) => candidate.startsWith('Background session: '));
    if (!line) continue;
    try {
      const parsed = JSON.parse(line.slice('Background session: '.length)) as Record<string, unknown>;
      const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim().slice(0, 256) : '';
      const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 80) : '';
      if (!sessionId || !title || sessions.some((session) => session.sessionId === sessionId)) continue;
      const turnId = typeof parsed.turnId === 'string' ? parsed.turnId.trim().slice(0, 256) : '';
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 280) : '';
      sessions.push({
        sessionId,
        ...(turnId ? { turnId } : {}),
        title,
        ...(summary ? { summary } : {}),
        status: typeof parsed.status === 'string' ? parsed.status.trim().slice(0, 32) || 'running' : 'running',
      });
      if (sessions.length >= 4) break;
    } catch {
      // Ignore malformed local tool output at the Cloud trust boundary.
    }
  }
  return sessions;
}

export function cloudAgentPublicBackgroundToolsFromTurn(
  turn: Pick<DesktopChatTurnSnapshot, 'tools'>,
): CloudAgentExecutionTool[] {
  return cloudAgentBackgroundSessionsFromTurn(turn).map((session) => ({
    id: `background-session:${session.sessionId}`,
    name: 'task_operator',
    status: 'completed',
    arguments: JSON.stringify({ taskTitle: session.title, summary: session.summary }),
    liveOutput: '',
    resultText: `Background session: ${JSON.stringify(session)}`,
    detail: session.summary ?? session.title,
    toolLayer: 'operator',
    isError: false,
  }));
}

export function parseCloudAgentBackgroundSessions(value: unknown): CloudAgentBackgroundSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim().slice(0, 256) : '';
    const title = typeof record.title === 'string' ? record.title.trim().slice(0, 80) : '';
    if (!sessionId || !title) return [];
    const turnId = typeof record.turnId === 'string' ? record.turnId.trim().slice(0, 256) : '';
    const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, 280) : '';
    return [{
      sessionId,
      ...(turnId ? { turnId } : {}),
      title,
      ...(summary ? { summary } : {}),
      status: typeof record.status === 'string' ? record.status.trim().slice(0, 32) || 'running' : 'running',
    }];
  }).slice(0, 4);
}

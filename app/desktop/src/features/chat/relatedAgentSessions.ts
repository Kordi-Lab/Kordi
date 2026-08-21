import type { Conversation, DesktopChatToolSnapshot, DesktopChatTurnSnapshot } from '@/kordi-app/types';

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

export type RelatedAgentSessionRunStatus = 'running' | 'done' | 'failed' | 'stopped';

function runStatusFromTurn(turn: DesktopChatTurnSnapshot): RelatedAgentSessionRunStatus {
  const status = turn.status.trim().toLowerCase();
  if (!turn.completed) return status === 'cancelling' ? 'stopped' : 'running';
  if (status === 'cancelled' || status === 'canceled') return 'stopped';
  if (!turn.succeeded || turn.error?.trim() || ['failed', 'error', 'crashed'].includes(status)) return 'failed';
  return 'done';
}

function latestConversationTurn(conversation: Conversation) {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const turn = conversation.messages[index]?.turn;
    if (turn) return turn;
  }
  return null;
}

function conversationRunStatus(conversation: Conversation): RelatedAgentSessionRunStatus | null {
  if (conversation.previewLiveTurn) return runStatusFromTurn(conversation.previewLiveTurn);
  if (conversation.statusIndicator?.live || conversation.statusIndicator?.tone === 'running') return 'running';
  if (conversation.statusIndicator?.tone === 'error') return 'failed';
  if (conversation.statusIndicator?.tone === 'stopped') return 'stopped';
  const latestTurn = latestConversationTurn(conversation);
  if (latestTurn) return runStatusFromTurn(latestTurn);
  return null;
}

export function relatedAgentSessionStatusById(
  conversations: readonly Conversation[],
): ReadonlyMap<string, RelatedAgentSessionRunStatus> {
  const statuses = new Map<string, RelatedAgentSessionRunStatus>();
  for (const conversation of conversations) {
    const status = conversationRunStatus(conversation);
    if (!status) continue;
    statuses.set(conversation.id, status);
    if (conversation.canonicalSessionId) statuses.set(conversation.canonicalSessionId, status);
  }
  return statuses;
}

export function normalizedRelatedAgentSessionStatus(status: string): RelatedAgentSessionRunStatus {
  const normalized = status.trim().toLowerCase();
  if (['done', 'complete', 'completed', 'succeeded', 'success'].includes(normalized)) return 'done';
  if (['failed', 'error', 'crashed'].includes(normalized)) return 'failed';
  if (['cancelled', 'canceled', 'stopped'].includes(normalized)) return 'stopped';
  return 'running';
}

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

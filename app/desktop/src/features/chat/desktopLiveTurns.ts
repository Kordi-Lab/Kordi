import type { DesktopChatMessage, DesktopChatState, DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';

export function buildCompletedDesktopAssistantMessage(turn: DesktopChatTurnSnapshot, finishedAt: string): DesktopChatMessage {
  const assistantText = turn.assistantText.trim();
  const fallbackText = turn.error?.trim() || turn.message?.trim() || '';

  return {
    role: 'assistant',
    sender: 'My Kordi',
    text: assistantText.length > 0 ? assistantText : fallbackText,
    detail: undefined,
    timeLabel: finishedAt,
    timestampMs: Date.now(),
    failed: !turn.succeeded && turn.status !== 'cancelled',
    thinkingText: turn.thinkingText,
    tools: turn.tools,
    turnStartedAtMs: turn.startedAtMs ?? null,
    turnCompletedAtMs: turn.completedAtMs ?? null,
  };
}

function liveTurnToolKey(tool: DesktopChatTurnSnapshot['tools'][number]) {
  return [
    tool.id,
    tool.name,
    tool.status,
    tool.arguments,
    tool.liveOutput,
    tool.resultText ?? '',
    tool.detail ?? '',
    tool.artifactPath ?? '',
    tool.toolLayer ?? '',
    String(tool.isError),
  ].join('\u0000');
}

function longerLiveText(current: string, next: string) {
  return next.length >= current.length ? next : current;
}

function mergeDesktopTurnToolSnapshot(
  current: DesktopChatTurnSnapshot['tools'][number],
  next: DesktopChatTurnSnapshot['tools'][number],
): DesktopChatTurnSnapshot['tools'][number] {
  const artifactPath = next.artifactPath || current.artifactPath;
  const toolLayer = next.toolLayer || current.toolLayer;
  return {
    ...current,
    ...next,
    arguments: longerLiveText(current.arguments ?? '', next.arguments ?? ''),
    liveOutput: longerLiveText(current.liveOutput ?? '', next.liveOutput ?? ''),
    resultText: next.resultText || current.resultText,
    detail: next.detail || current.detail,
    ...(artifactPath ? { artifactPath } : {}),
    ...(toolLayer ? { toolLayer } : {}),
  };
}

export function mergeDesktopTurnSnapshot(
  current: DesktopChatTurnSnapshot | undefined,
  next: DesktopChatTurnSnapshot,
): DesktopChatTurnSnapshot {
  if (!current || current.id !== next.id) return next;

  const currentToolsById = new Map(current.tools.map((tool) => [tool.id, tool]));
  const nextToolIds = new Set(next.tools.map((tool) => tool.id));
  const mergedTools = next.tools.map((tool) => {
    const existing = currentToolsById.get(tool.id);
    return existing ? mergeDesktopTurnToolSnapshot(existing, tool) : tool;
  });

  const startedAtMs = current.startedAtMs ?? next.startedAtMs;
  const completedAtMs = next.completedAtMs ?? current.completedAtMs;

  return {
    ...current,
    ...next,
    assistantText: longerLiveText(current.assistantText, next.assistantText),
    thinkingText: longerLiveText(current.thinkingText, next.thinkingText),
    ...(startedAtMs != null ? { startedAtMs } : {}),
    ...(completedAtMs != null ? { completedAtMs } : {}),
    tools: [
      ...mergedTools,
      ...current.tools.filter((tool) => !nextToolIds.has(tool.id)),
    ],
  };
}

function normalizedTranscriptText(value?: string | null) {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function liveTurnResponseText(turn: DesktopChatTurnSnapshot) {
  return normalizedTranscriptText(turn.assistantText)
    || normalizedTranscriptText(turn.error)
    || (turn.completed ? normalizedTranscriptText(turn.message) : '');
}

export function turnHasHistoricalArtifacts(turn: DesktopChatTurnSnapshot) {
  return turn.thinkingText.trim().length > 0 || turn.tools.length > 0;
}

export function desktopAssistantMessageMatchesTurn(message: DesktopChatMessage, turn: DesktopChatTurnSnapshot) {
  if (message.role !== 'assistant') return false;
  const turnText = liveTurnResponseText(turn);
  if (turnText.length > 0 && normalizedTranscriptText(message.text) !== turnText) return false;
  if (turnText.length === 0 && !turnHasHistoricalArtifacts(turn)) return false;

  const turnThinking = normalizedTranscriptText(turn.thinkingText);
  if (turnThinking.length > 0 && normalizedTranscriptText(message.thinkingText) !== turnThinking) {
    return false;
  }

  if (turn.tools.length > 0 && (message.tools?.length ?? 0) < turn.tools.length) {
    return false;
  }

  return true;
}

export function desktopStateIncludesCompletedTurn(state: DesktopChatState, turn: DesktopChatTurnSnapshot) {
  return state.activeSession.id === turn.sessionId
    && state.activeSession.messages.some((message) => desktopAssistantMessageMatchesTurn(message, turn));
}

function transcriptMessageMatchesIncompleteLiveTurn(message: Message, turn: DesktopChatTurnSnapshot) {
  if (message.role !== 'owned-agent') return false;
  const turnText = liveTurnResponseText(turn);
  if (turnText.length > 0 && normalizedTranscriptText(message.text) === turnText) return true;

  const turnThinking = normalizedTranscriptText(turn.thinkingText);
  if (turnThinking.length > 0 && normalizedTranscriptText(message.turn?.thinkingText) === turnThinking) {
    return true;
  }

  return turn.tools.length > 0 && (message.turn?.tools.length ?? 0) >= turn.tools.length;
}

export function suppressIncompleteLiveTurnEcho(messages: Message[], turn?: DesktopChatTurnSnapshot) {
  if (!turn || turn.completed) return messages;
  let echoIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (transcriptMessageMatchesIncompleteLiveTurn(messages[index], turn)) {
      echoIndex = index;
      break;
    }
  }
  if (echoIndex < 0) return messages;
  return messages.filter((_, index) => index !== echoIndex);
}

export function liveTurnSnapshotChanged(left: DesktopChatTurnSnapshot | undefined, right: DesktopChatTurnSnapshot) {
  if (!left) return true;
  if (
    left.id !== right.id
    || left.sessionId !== right.sessionId
    || left.status !== right.status
    || left.message !== right.message
    || left.assistantText !== right.assistantText
    || left.thinkingText !== right.thinkingText
    || left.completed !== right.completed
    || left.succeeded !== right.succeeded
    || left.startedAtMs !== right.startedAtMs
    || left.completedAtMs !== right.completedAtMs
    || left.error !== right.error
    || Boolean(left.transcriptRefreshRequired) !== Boolean(right.transcriptRefreshRequired)
    || left.tools.length !== right.tools.length
  ) {
    return true;
  }

  return left.tools.some((tool, index) => liveTurnToolKey(tool) !== liveTurnToolKey(right.tools[index]));
}

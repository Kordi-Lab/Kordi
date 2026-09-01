import type { DesktopChatMessage, DesktopChatState, DesktopChatTurnSnapshot, Message } from '@/kordi-app/types';
import { formatDesktopClockTime } from '@/lib/time';

export const NO_PROVIDER_PENDING_LIVE_TURN_PREFIX = 'turn:no-provider-pending:';

export function shouldPollDesktopLiveTurn(turn: DesktopChatTurnSnapshot): boolean {
  return !turn.completed
    && !turn.id.startsWith('local-agent-starting:')
    && !turn.id.startsWith(NO_PROVIDER_PENDING_LIVE_TURN_PREFIX);
}

export type DesktopTurnRenderAlias = {
  turnId: string;
  sessionId: string;
  entryId: string | null;
  displayTimestampMs: number;
  displayTimeLabel: string;
  completedAtMs: number | null;
  responseText: string;
  thinkingText: string;
  toolIds: string[];
  failed: boolean;
  cancelled: boolean;
};

function usableTimestamp(value?: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function desktopTurnDisplayTimestampMs(
  turn: DesktopChatTurnSnapshot,
  fallbackTimestampMs = Date.now(),
) {
  if (usableTimestamp(turn.startedAtMs)) return turn.startedAtMs;
  if (usableTimestamp(turn.completedAtMs)) return turn.completedAtMs;
  return fallbackTimestampMs;
}

export function desktopTurnDisplayTimeLabel(
  turn: DesktopChatTurnSnapshot,
  fallbackTimestampMs = Date.now(),
) {
  return formatDesktopClockTime(new Date(desktopTurnDisplayTimestampMs(turn, fallbackTimestampMs)));
}

export function desktopTurnWorkDurationLabel(
  turn: Pick<DesktopChatTurnSnapshot, 'startedAtMs' | 'completedAtMs'>,
) {
  if (!usableTimestamp(turn.startedAtMs) || !usableTimestamp(turn.completedAtMs)) return null;
  const elapsedSeconds = Math.max(0, Math.round((turn.completedAtMs - turn.startedAtMs) / 1_000));
  if (elapsedSeconds < 1) return 'Worked for <1s';
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  const parts = [
    hours > 0 ? `${hours}h` : '',
    minutes > 0 ? `${minutes}m` : '',
    seconds > 0 || (hours === 0 && minutes === 0) ? `${seconds}s` : '',
  ].filter(Boolean);
  return `Worked for ${parts.join(' ')}`;
}

export function buildDesktopLiveTurnTranscriptMessage(
  turn: DesktopChatTurnSnapshot,
  sender = 'My Kordi',
  fallbackTimestampMs = Date.now(),
): Message {
  const timestampMs = desktopTurnDisplayTimestampMs(turn, fallbackTimestampMs);
  return {
    id: turn.id,
    entryId: null,
    role: 'owned-agent',
    sender,
    sourceSenderLabel: sender,
    text: turn.assistantText,
    time: formatDesktopClockTime(new Date(timestampMs)),
    timestampMs,
    turn,
  };
}

export function buildCompletedDesktopAssistantMessage(
  turn: DesktopChatTurnSnapshot,
  fallbackTimestampMs = Date.now(),
): DesktopChatMessage {
  const assistantText = turn.assistantText.trim();
  const fallbackText = turn.error?.trim() || turn.message?.trim() || '';
  const timestampMs = desktopTurnDisplayTimestampMs(turn, fallbackTimestampMs);

  return {
    role: 'assistant',
    entryId: turn.transcriptEntryId?.trim() || null,
    sender: 'My Kordi',
    text: assistantText.length > 0 ? assistantText : turn.status === 'cancelled' ? '' : fallbackText,
    detail: undefined,
    timeLabel: formatDesktopClockTime(new Date(timestampMs)),
    timestampMs,
    failed: !turn.succeeded && turn.status !== 'cancelled',
    cancelled: turn.status === 'cancelled',
    thinkingText: turn.thinkingText,
    tools: turn.tools,
    turnStartedAtMs: turn.startedAtMs ?? null,
    turnCompletedAtMs: turn.completedAtMs ?? null,
    transcriptRenderId: turn.id,
    replyToMessageId: turn.replyToMessageId ?? null,
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

export function createDesktopTurnRenderAlias(
  turn: DesktopChatTurnSnapshot,
  fallbackTimestampMs = Date.now(),
): DesktopTurnRenderAlias {
  const displayTimestampMs = desktopTurnDisplayTimestampMs(turn, fallbackTimestampMs);
  return {
    turnId: turn.id,
    sessionId: turn.sessionId,
    entryId: turn.transcriptEntryId?.trim() || null,
    displayTimestampMs,
    displayTimeLabel: formatDesktopClockTime(new Date(displayTimestampMs)),
    completedAtMs: turn.completedAtMs ?? null,
    responseText: liveTurnResponseText(turn),
    thinkingText: normalizedTranscriptText(turn.thinkingText),
    toolIds: turn.tools.map((tool) => tool.id),
    failed: !turn.succeeded && turn.status !== 'cancelled',
    cancelled: turn.status === 'cancelled',
  };
}

function desktopMessageMatchesTurnRenderAlias(
  message: DesktopChatMessage,
  alias: DesktopTurnRenderAlias,
) {
  if (message.role !== 'assistant') return false;
  if (alias.responseText && normalizedTranscriptText(message.text) !== alias.responseText) return false;
  if (!alias.responseText && !alias.thinkingText && alias.toolIds.length === 0 && !alias.cancelled) return false;
  if (alias.thinkingText && normalizedTranscriptText(message.thinkingText) !== alias.thinkingText) return false;
  if (alias.failed !== Boolean(message.failed)) return false;
  if (alias.cancelled !== Boolean(message.cancelled)) return false;
  if (alias.toolIds.length > 0) {
    const messageToolIds = new Set((message.tools ?? []).map((tool) => tool.id));
    if (alias.toolIds.some((toolId) => !messageToolIds.has(toolId))) return false;
  }
  return true;
}

function messageWithTurnRenderAlias(
  message: DesktopChatMessage,
  alias: DesktopTurnRenderAlias,
): DesktopChatMessage {
  if (
    message.transcriptRenderId === alias.turnId
    && message.timeLabel === alias.displayTimeLabel
    && message.turnStartedAtMs === alias.displayTimestampMs
    && message.turnCompletedAtMs === alias.completedAtMs
  ) {
    return message;
  }
  return {
    ...message,
    transcriptRenderId: alias.turnId,
    timeLabel: alias.displayTimeLabel,
    turnStartedAtMs: alias.displayTimestampMs,
    turnCompletedAtMs: alias.completedAtMs,
  };
}

export function reconcileDesktopMessagesWithTurnRenderAliases(
  sessionId: string,
  messages: DesktopChatMessage[],
  aliases: ReadonlyMap<string, DesktopTurnRenderAlias>,
) {
  const sessionAliases = [...aliases.values()]
    .filter((alias) => alias.sessionId === sessionId)
    .reverse();
  if (sessionAliases.length === 0 || messages.length === 0) return messages;

  const messageIndexByEntryId = new Map<string, number>();
  messages.forEach((message, index) => {
    const entryId = message.entryId?.trim();
    if (entryId) messageIndexByEntryId.set(entryId, index);
  });

  let reconciled: DesktopChatMessage[] | null = null;
  const claimedMessageIndexes = new Set<number>();
  for (const alias of sessionAliases) {
    let messageIndex = alias.entryId
      ? (messageIndexByEntryId.get(alias.entryId) ?? -1)
      : -1;
    if (messageIndex < 0 && !alias.entryId) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (claimedMessageIndexes.has(index)) continue;
        const candidate = messages[index];
        if (candidate && desktopMessageMatchesTurnRenderAlias(candidate, alias)) {
          messageIndex = index;
          break;
        }
      }
    }
    if (messageIndex < 0) continue;

    claimedMessageIndexes.add(messageIndex);
    const message = messages[messageIndex];
    if (!message) continue;
    const entryId = message.entryId?.trim();
    if (entryId) alias.entryId = entryId;
    const nextMessage = messageWithTurnRenderAlias(message, alias);
    if (nextMessage === message) continue;
    reconciled ??= [...messages];
    reconciled[messageIndex] = nextMessage;
  }

  return reconciled ?? messages;
}

function liveTurnResponseText(turn: DesktopChatTurnSnapshot) {
  return normalizedTranscriptText(turn.assistantText)
    || normalizedTranscriptText(turn.error)
    || (turn.completed ? normalizedTranscriptText(turn.message) : '');
}

export function turnHasHistoricalArtifacts(turn: DesktopChatTurnSnapshot) {
  return turn.thinkingText.trim().length > 0 || turn.tools.length > 0;
}

export function shouldConfirmCompletedDesktopTurnTranscript(
  turn: DesktopChatTurnSnapshot,
  isVisibleSession: boolean,
) {
  if (!isVisibleSession) return false;
  const turnFailed = !turn.succeeded && turn.status !== 'cancelled';
  if (turnFailed) return false;

  // A completed plain-text response still needs the same persisted-history
  // handoff as a tool/thinking turn. The visible canonical conversation can be
  // ahead of desktopChatState after forwarding or rapid session selection, and
  // its inactive-session cache may not exist yet. Confirming the runtime row
  // before removing the live snapshot prevents the reply from flashing and
  // then disappearing in that state.
  return turn.succeeded
    || Boolean(turn.transcriptRefreshRequired)
    || turnHasHistoricalArtifacts(turn);
}

export function desktopAssistantMessageMatchesTurn(message: DesktopChatMessage, turn: DesktopChatTurnSnapshot) {
  if (message.role !== 'assistant') return false;
  const transcriptEntryId = turn.transcriptEntryId?.trim();
  if (transcriptEntryId) return message.entryId?.trim() === transcriptEntryId;
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
    || left.transcriptEntryId !== right.transcriptEntryId
    || left.error !== right.error
    || Boolean(left.transcriptRefreshRequired) !== Boolean(right.transcriptRefreshRequired)
    || left.tools.length !== right.tools.length
  ) {
    return true;
  }

  return left.tools.some((tool, index) => liveTurnToolKey(tool) !== liveTurnToolKey(right.tools[index]));
}

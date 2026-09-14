import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';

export function liveTurnSnapshotKey(turn: DesktopChatTurnSnapshot) {
  return [
    turn.id,
    turn.sessionId,
    turn.startedAtMs ?? '',
    turn.completedAtMs ?? '',
    turn.localExecutionStarted ? `${turn.status}:local-started` : turn.status,
    turn.message,
    turn.assistantText,
    turn.thinkingText,
    turn.completed ? 'completed' : 'running',
    turn.succeeded ? 'succeeded' : 'pending',
    turn.error ?? '',
    turn.transcriptRefreshRequired ? 'refresh' : 'stable',
    turn.replyToMessageId ?? '',
    turn.sourceMessage ? [turn.sourceMessage.messageId, turn.sourceMessage.text, turn.sourceMessage.senderLabel ?? ''].join(':') : '',
    turn.pendingCollaborationAgentRequest?.conversationId ?? '',
    turn.pendingCollaborationAgentRequest?.requestId ?? '',
    ...turn.tools.map((tool) => [
      tool.id,
      tool.name,
      tool.status,
      tool.arguments,
      tool.liveOutput,
      tool.resultText ?? '',
      tool.detail ?? '',
      tool.artifactPath ?? '',
      tool.toolLayer ?? '',
      tool.isError ? 'error' : 'ok',
    ].join('\u0000')),
  ].join('\u0001');
}

import type { DesktopChatTurnSnapshot } from '@/kordi-app/types';
import {
  firstMeaningfulThinkingLine,
  toolTimelineRunningToolLabel,
  toolTimelineToolLabel,
} from '@/kordi-app/components/toolTimeline';
import type {
  CloudAgentExecutionSnapshot,
  CloudAgentExecutionStep,
  CloudAgentExecutionTool,
  CloudAgentResponseEnvelope,
} from './cloudAgentMessages';
import type { CloudMessage } from './authClient';
import { isProcessingPlaceholderText } from '@/features/collaboration/agentPlaceholderText';

function compactLabel(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned
    .split(' ')
    .map((part) => part.length > 1
      ? `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`
      : part.toUpperCase())
    .join(' ')
    .slice(0, 80);
}

const SENSITIVE_TOOL_FIELD = /(?:authorization|cookie|credential|password|private.?key|secret|token|api.?key)/i;

function redactSensitiveToolText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(
      /\b(authorization|cookie|credential|password|private.?key|secret|token|api.?key)\s*([=:])\s*([^\s'";]+)/gi,
      '$1$2[redacted]',
    );
}

function sanitizedOwnerToolArguments(rawArguments: string): string {
  if (!rawArguments.trim()) return '';
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    const sanitize = (value: unknown, key = ''): unknown => {
      if (SENSITIVE_TOOL_FIELD.test(key)) return '[redacted]';
      if (Array.isArray(value)) return value.map((item) => sanitize(item));
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .map(([entryKey, entryValue]) => [
              entryKey,
              sanitize(entryValue, entryKey),
            ]),
        );
      }
      if (typeof value === 'string') return redactSensitiveToolText(value);
      return value;
    };
    return JSON.stringify(sanitize(parsed));
  } catch {
    return '';
  }
}

function ownerVisibleTool(
  tool: DesktopChatTurnSnapshot['tools'][number],
): CloudAgentExecutionTool {
  const resultText = tool.resultText
    ? redactSensitiveToolText(tool.resultText)
    : tool.resultText;
  const detail = tool.detail
    ? redactSensitiveToolText(tool.detail)
    : tool.detail;
  return {
    id: tool.id,
    name: tool.name,
    status: tool.status,
    arguments: sanitizedOwnerToolArguments(tool.arguments),
    liveOutput: redactSensitiveToolText(tool.liveOutput),
    ...(resultText !== undefined ? { resultText } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(tool.toolLayer !== undefined ? { toolLayer: tool.toolLayer } : {}),
    isError: tool.isError,
  };
}

function toolState(
  tool: DesktopChatTurnSnapshot['tools'][number],
): CloudAgentExecutionStep['state'] {
  if (tool.isError) return 'failed';
  const status = tool.status.trim().toLowerCase();
  if (['complete', 'completed', 'success', 'succeeded', 'done'].includes(status)) {
    return 'complete';
  }
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
    return 'failed';
  }
  if (['queued', 'pending'].includes(status)) return 'pending';
  return 'running';
}

function safeExecutionSteps(
  turn: DesktopChatTurnSnapshot,
): CloudAgentExecutionStep[] {
  const steps: CloudAgentExecutionStep[] = [];
  if (turn.thinkingText.trim()) {
    steps.push({
      id: 'analysis',
      label: firstMeaningfulThinkingLine(turn.thinkingText).slice(0, 160),
      state: turn.tools.length > 0 || turn.assistantText.trim()
        ? 'complete'
        : 'running',
    });
  }
  for (const tool of turn.tools.slice(-10)) {
    const state = toolState(tool);
    const visibleTool = ownerVisibleTool(tool);
    steps.push({
      id: `tool:${tool.id}`.slice(0, 160),
      label: (state === 'running'
        ? toolTimelineRunningToolLabel(visibleTool)
        : toolTimelineToolLabel(visibleTool)
      ).slice(0, 160) || compactLabel(tool.name, 'Tool execution'),
      state,
    });
  }
  if (turn.assistantText.trim()) {
    steps.push({
      id: 'response',
      label: 'Writing the response',
      state: turn.completed ? 'complete' : 'running',
    });
  }
  return steps.slice(-12);
}

export function cloudAgentExecutionSnapshotFromTurn(
  turn: DesktopChatTurnSnapshot,
  updatedAtMs = Date.now(),
): CloudAgentExecutionSnapshot {
  const steps = safeExecutionSteps(turn);
  const runningTool = [...steps].reverse().find((step) => (
    step.id.startsWith('tool:') && step.state === 'running'
  ));
  const failed = turn.status === 'failed' || Boolean(turn.error);
  const cancelled = turn.status === 'cancelled';
  const phase: CloudAgentExecutionSnapshot['phase'] = cancelled
    ? 'cancelled'
    : failed
      ? 'failed'
      : turn.completed
        ? 'complete'
        : runningTool
          ? 'using-tool'
          : turn.assistantText.trim()
            ? 'writing'
            : turn.thinkingText.trim()
              ? 'analyzing'
              : 'preparing';
  const summary = cancelled
    ? 'Execution canceled'
    : failed
      ? 'Execution needs attention'
      : turn.completed
        ? 'Execution complete'
        : runningTool?.label
          ?? (phase === 'writing'
            ? 'Writing the response'
            : phase === 'analyzing'
              ? 'Analyzing the request'
              : 'Preparing the response');
  return {
    phase,
    summary,
    steps,
    ...(turn.thinkingText.trim()
      ? { thinkingText: redactSensitiveToolText(turn.thinkingText) }
      : {}),
    ...(turn.tools.length
      ? { tools: turn.tools.slice(-10).map(ownerVisibleTool) }
      : {}),
    ...(typeof turn.startedAtMs === 'number'
      && Number.isFinite(turn.startedAtMs)
      ? { startedAtMs: turn.startedAtMs }
      : {}),
    updatedAtMs,
    completed: turn.completed,
  };
}

export function finalizeCloudAgentExecutionSnapshot(
  snapshot: CloudAgentExecutionSnapshot | undefined,
  deliveryState: Exclude<CloudAgentResponseEnvelope['deliveryState'], 'processing' | undefined>,
  updatedAtMs = Date.now(),
): CloudAgentExecutionSnapshot | undefined {
  if (!snapshot) return undefined;
  const phase = deliveryState === 'complete'
    ? 'complete'
    : deliveryState === 'cancelled'
      ? 'cancelled'
      : 'failed';
  return {
    ...snapshot,
    phase,
    summary: phase === 'complete'
      ? 'Execution complete'
      : phase === 'cancelled'
        ? 'Execution canceled'
        : 'Execution needs attention',
    steps: snapshot.steps.map((step) => (
      step.state === 'running' || step.state === 'pending'
        ? { ...step, state: phase === 'complete' ? 'complete' : 'failed' }
        : step
    )),
    updatedAtMs,
    completed: true,
  };
}

export function cloudAgentExecutionFingerprint(
  snapshot: CloudAgentExecutionSnapshot,
  assistantText = '',
): string {
  return [
    snapshot.phase,
    snapshot.summary,
    snapshot.completed ? '1' : '0',
    snapshot.thinkingText ?? '',
    ...(snapshot.tools ?? []).map((tool) => [
      tool.id,
      tool.name,
      tool.status,
      tool.arguments,
      tool.liveOutput,
      tool.resultText ?? '',
      tool.detail ?? '',
      tool.isError ? '1' : '0',
    ].join(':')),
    ...snapshot.steps.map((step) => `${step.id}:${step.label}:${step.state}`),
    assistantText,
  ].join('\u0000');
}

export function cloudAgentExecutionTurnForMessage(
  message: CloudMessage,
  response: CloudAgentResponseEnvelope | null,
): DesktopChatTurnSnapshot | null {
  if (
    !response?.execution
    || message.fromAccountId !== message.toAccountId
  ) return null;
  return cloudAgentExecutionTurnSnapshot({
    execution: response.execution,
    response,
    sessionId: message.sessionId ?? `cloud-agent:${response.requestId}`,
  });
}

export function cloudAgentExecutionTurnSnapshot({
  execution,
  response,
  sessionId,
}: {
  execution: CloudAgentExecutionSnapshot;
  response: CloudAgentResponseEnvelope;
  sessionId: string;
}): DesktopChatTurnSnapshot {
  return {
    id: `cloud-agent-execution:${response.requestId}`,
    sessionId,
    prompt: '',
    status: execution.phase,
    message: execution.summary,
    assistantText: response.deliveryState === 'processing'
      && isProcessingPlaceholderText(response.text)
      ? ''
      : response.text,
    thinkingText: execution.thinkingText ?? '',
    tools: execution.tools ?? [],
    completed: execution.completed,
    succeeded: response.deliveryState === 'complete',
    startedAtMs: execution.startedAtMs ?? null,
    completedAtMs: execution.completed ? execution.updatedAtMs : null,
    error: response.deliveryState === 'failed' ? response.text : null,
    transcriptRefreshRequired: false,
  };
}

export function cloudAgentExecutionCanonicalContent(
  execution: CloudAgentExecutionSnapshot | undefined,
): Record<string, unknown> {
  if (!execution) return {};
  return {
    execution,
    executionSummary: execution.summary,
    executionUpdatedAtMs: execution.updatedAtMs,
    thinkingText: execution.thinkingText ?? '',
    tools: execution.tools ?? [],
  };
}

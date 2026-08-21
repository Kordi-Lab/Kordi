export type CloudAgentExecutionStep = {
  id: string;
  label: string;
  state: 'pending' | 'running' | 'complete' | 'failed';
};

export type CloudAgentExecutionTool = {
  id: string;
  name: string;
  status: string;
  arguments: string;
  liveOutput: string;
  resultText?: string | null;
  detail?: string | null;
  toolLayer?: string | null;
  isError: boolean;
};

/** Owner-visible execution state shared only between devices on the same account. */
export type CloudAgentExecutionSnapshot = {
  phase: 'preparing' | 'analyzing' | 'using-tool' | 'writing' | 'complete' | 'failed' | 'cancelled';
  summary: string;
  steps: CloudAgentExecutionStep[];
  thinkingText?: string;
  tools?: CloudAgentExecutionTool[];
  startedAtMs?: number;
  updatedAtMs: number;
  completed: boolean;
};

export function parseCloudAgentExecutionSnapshot(
  value: unknown,
): CloudAgentExecutionSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const phases: CloudAgentExecutionSnapshot['phase'][] = [
    'preparing',
    'analyzing',
    'using-tool',
    'writing',
    'complete',
    'failed',
    'cancelled',
  ];
  const phase = typeof record.phase === 'string'
    && phases.includes(record.phase as CloudAgentExecutionSnapshot['phase'])
    ? record.phase as CloudAgentExecutionSnapshot['phase']
    : null;
  const summary = typeof record.summary === 'string'
    ? record.summary.trim().slice(0, 160)
    : '';
  const updatedAtMs = typeof record.updatedAtMs === 'number'
    && Number.isFinite(record.updatedAtMs)
    ? record.updatedAtMs
    : null;
  if (!phase || !summary || updatedAtMs === null) return null;
  const states: CloudAgentExecutionStep['state'][] = [
    'pending',
    'running',
    'complete',
    'failed',
  ];
  const steps = Array.isArray(record.steps)
    ? record.steps.flatMap((step): CloudAgentExecutionStep[] => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
      const item = step as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id.trim().slice(0, 160) : '';
      const label = typeof item.label === 'string' ? item.label.trim().slice(0, 160) : '';
      const state = typeof item.state === 'string'
        && states.includes(item.state as CloudAgentExecutionStep['state'])
        ? item.state as CloudAgentExecutionStep['state']
        : null;
      return id && label && state ? [{ id, label, state }] : [];
    }).slice(0, 12)
    : [];
  const startedAtMs = typeof record.startedAtMs === 'number'
    && Number.isFinite(record.startedAtMs)
    ? record.startedAtMs
    : undefined;
  const thinkingText = typeof record.thinkingText === 'string'
    ? record.thinkingText.slice(0, 64 * 1_024)
    : undefined;
  const tools = Array.isArray(record.tools)
    ? record.tools.flatMap((tool): CloudAgentExecutionTool[] => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return [];
      const item = tool as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id.trim().slice(0, 160) : '';
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 160) : '';
      const status = typeof item.status === 'string' ? item.status.trim().slice(0, 80) : '';
      if (!id || !name || !status) return [];
      const optionalText = (key: string, limit: number) => {
        const text = item[key];
        return typeof text === 'string' ? text.slice(0, limit) : undefined;
      };
      const resultText = optionalText('resultText', 64 * 1_024);
      const detail = optionalText('detail', 8 * 1_024);
      const toolLayer = optionalText('toolLayer', 160);
      return [{
        id,
        name,
        status,
        arguments: optionalText('arguments', 64 * 1_024) ?? '',
        liveOutput: optionalText('liveOutput', 64 * 1_024) ?? '',
        ...(resultText !== undefined ? { resultText } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...(toolLayer !== undefined ? { toolLayer } : {}),
        isError: item.isError === true,
      }];
    }).slice(-10)
    : undefined;
  return {
    phase,
    summary,
    steps,
    ...(thinkingText ? { thinkingText } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    updatedAtMs,
    completed: record.completed === true,
  };
}

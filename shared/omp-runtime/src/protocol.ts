export const SCHEMA_VERSION = 1;
export type JsonObject = Record<string, any>;
export type RunRequest = {
  schemaVersion: 1; type: 'run'; requestId: string; runId: string; attemptId: string;
  sessionId: string; cwd: string;
  model: { provider: string; id: string; api?: string; baseUrl?: string; contextWindow?: number; maxTokens?: number };
  auth: { kind: 'api_key' | 'oauth' | 'none'; credential?: string; headers?: Record<string, string> };
  systemPrompt: string; messages: JsonObject[];
  messageEntryIds?: (string | null)[];
  prompt: { text: string; entryId?: string; trailingMessages?: JsonObject[]; images?: { type: 'image'; data: string; mimeType: string }[] };
  thinking?: string;
  tools: { name: string; description: string; inputSchema: JsonObject }[];
  hooks?: ('context' | 'before_provider_request')[];
  capabilities?: { ownerLocal: boolean; computer: boolean; browser: boolean };
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number; thresholdTokens?: number };
  limits: { timeoutMs: number; maxOutputBytes: number; maxToolCalls: number; maxSteps: number };
};
export type ToolResult = { ok: boolean; content: JsonObject[]; details?: unknown };
export type WorkerCommand = RunRequest | {
  schemaVersion: 1; type: 'tool_result'; runId: string; attemptId: string; callId: string; result: ToolResult;
} | { schemaVersion: 1; type: 'hook_result'; runId: string; attemptId: string; callId: string; result: JsonObject
} | { schemaVersion: 1; type: 'cancel'; runId: string; attemptId: string };

export class RuntimeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
const invalid = () => new RuntimeError('invalid_request', 'Invalid OMP runtime request.');
export function parseCommand(line: string): WorkerCommand {
  let value: any;
  try { value = JSON.parse(line); } catch { throw invalid(); }
  if (!value || value.schemaVersion !== 1 || typeof value.runId !== 'string' || typeof value.attemptId !== 'string') throw invalid();
  if (value.type === 'cancel') return value;
  if (value.type === 'hook_result') {
    if (typeof value.callId !== 'string' || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) throw invalid();
    return value;
  }
  if (value.type === 'tool_result') {
    if (typeof value.callId !== 'string' || typeof value.result?.ok !== 'boolean' || !Array.isArray(value.result.content)) throw invalid();
    return value;
  }
  if (value.type !== 'run') throw invalid();
  for (const field of ['requestId', 'sessionId', 'cwd', 'systemPrompt']) if (typeof value[field] !== 'string') throw invalid();
  if (!value.cwd.startsWith('/') || typeof value.model?.provider !== 'string' || typeof value.model?.id !== 'string' ||
      !['api_key', 'oauth', 'none'].includes(value.auth?.kind) ||
      (value.auth.kind !== 'none' && (typeof value.auth.credential !== 'string' || !value.auth.credential)) ||
      typeof value.prompt?.text !== 'string' || !Array.isArray(value.messages) || !Array.isArray(value.tools)) throw invalid();
  for (const key of ['timeoutMs', 'maxOutputBytes', 'maxToolCalls', 'maxSteps']) {
    if (!Number.isSafeInteger(value.limits?.[key]) || value.limits[key] <= 0) throw invalid();
  }
  if (value.hooks && (!Array.isArray(value.hooks) || value.hooks.some((name: unknown) => !['context', 'before_provider_request'].includes(name as string)))) throw invalid();
  if (value.prompt.trailingMessages && (!Array.isArray(value.prompt.trailingMessages) || value.prompt.trailingMessages.some((message: any) => message?.role !== 'custom'))) throw invalid();
  const names = new Set();
  if (value.messageEntryIds && (!Array.isArray(value.messageEntryIds) || value.messageEntryIds.length !== value.messages.length ||
      value.messageEntryIds.some((id: unknown) => id !== null && typeof id !== 'string'))) throw invalid();
  for (const tool of value.tools) {
    if (!tool || typeof tool.name !== 'string' || !/^[\w.-]+$/.test(tool.name) || names.has(tool.name) ||
        typeof tool.description !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object') throw invalid();
    names.add(tool.name);
  }
  if (value.capabilities) {
    for (const key of ['ownerLocal', 'computer', 'browser']) if (typeof value.capabilities[key] !== 'boolean') throw invalid();
    if (!value.capabilities.ownerLocal && (value.capabilities.computer || value.capabilities.browser)) throw invalid();
  }
  if (value.compaction) {
    if (typeof value.compaction.enabled !== 'boolean') throw invalid();
    for (const key of ['reserveTokens', 'keepRecentTokens']) if (!Number.isSafeInteger(value.compaction[key]) || value.compaction[key] < 0) throw invalid();
  }
  return value;
}

import type { DesktopChatContextMessage } from '@/lib/desktop';

/**
 * Request-scoped reference context, such as the Ask Agent "Current chat"
 * reference, travels with a hosted self-agent request so whichever executor
 * claims the run can import it. Only history-role entries travel: system,
 * resource and runtime-identity messages are rebuilt by the executor.
 * The server applies the same bounds (cloud_agent_runtime prompt_history).
 */
export const MAX_REQUEST_CONTEXT_MESSAGES = 4;
export const MAX_REQUEST_CONTEXT_TEXT_CHARS = 4_000;
const MAX_REQUEST_CONTEXT_ID_CHARS = 200;
const MAX_REQUEST_CONTEXT_AUTHOR_CHARS = 80;
const EXECUTOR_OWNED_ID_PREFIXES = ['cloud-group-persona:', 'requester:'];

function clippedText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, maxChars).join('').trim();
}

/** Keeps at most a few well-formed history-role context messages, each clipped. */
export function boundedRequestContextMessages(value: unknown): DesktopChatContextMessage[] {
  if (!Array.isArray(value)) return [];
  const result: DesktopChatContextMessage[] = [];
  for (const item of value) {
    if (result.length >= MAX_REQUEST_CONTEXT_MESSAGES) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const role = record.contextRole;
    if (role !== undefined && role !== null && role !== 'history') continue;
    const id = clippedText(record.id, MAX_REQUEST_CONTEXT_ID_CHARS);
    const authorName = clippedText(record.authorName, MAX_REQUEST_CONTEXT_AUTHOR_CHARS);
    const text = clippedText(record.text, MAX_REQUEST_CONTEXT_TEXT_CHARS);
    if (!id || !authorName || !text) continue;
    if (EXECUTOR_OWNED_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) continue;
    const createdAtMs = typeof record.createdAtMs === 'number' && Number.isFinite(record.createdAtMs)
      ? record.createdAtMs
      : null;
    result.push({
      id,
      authorName,
      authorKind: record.authorKind === 'agent' ? 'agent' : 'human',
      text,
      ...(createdAtMs !== null ? { createdAtMs } : {}),
      ...(role === 'history' ? { contextRole: 'history' as const } : {}),
    });
  }
  return result;
}

/** Content fields a delivered hosted request stores so forward sync can carry its reference context. */
export function hostedRequestContextContent(
  contextMessages: readonly DesktopChatContextMessage[] | null | undefined,
): { agentContextMessages?: DesktopChatContextMessage[] } {
  const bounded = boundedRequestContextMessages(contextMessages ?? []);
  return bounded.length > 0 ? { agentContextMessages: bounded } : {};
}

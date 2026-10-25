// Proactive run hints from the sync stream. The executor that runs them
// lives in proactiveMacRuns.ts and is loaded only when a run arrives, so this
// module stays small in the cloud chunk.

export const PROACTIVE_EVAL_REQUESTED_EVENT = 'proactive.eval_requested';
export const PROACTIVE_RUN_REQUESTED_EVENT = 'proactive.run_requested';
const EVAL_PREFIX = 'proactive_eval_';
const APPROVED_PREFIX = 'proactive_run_';
const MAX_PENDING = 8;
const MAX_REMEMBERED = 256;

export type ProactiveRunRequest =
  | { kind: 'evaluation'; runId: string; sessionId: string }
  | { kind: 'approved'; runId: string; sessionId: string; agentId: string | null; proposalId: string | null };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Reads one `proactive.eval_requested` or `proactive.run_requested` hint. */
export function parseProactiveRunRequest(eventType: string | undefined, payload: unknown): ProactiveRunRequest | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const runId = text(record.runId);
  const sessionId = text(record.sessionId);
  if (!sessionId) return null;
  if (eventType === PROACTIVE_EVAL_REQUESTED_EVENT && runId.startsWith(EVAL_PREFIX)) {
    return { kind: 'evaluation', runId, sessionId };
  }
  if (eventType === PROACTIVE_RUN_REQUESTED_EVENT && runId.startsWith(APPROVED_PREFIX)) {
    return { kind: 'approved', runId, sessionId, agentId: text(record.agentId) || null, proposalId: text(record.proposalId) || null };
  }
  return null;
}

type Handler = (request: ProactiveRunRequest) => void;
let registered: { accountId: string; handler: Handler } | null = null;
let pending: Array<{ accountId: string; request: ProactiveRunRequest }> = [];
/** Run ids already handed to a handler: each run starts on this Mac once. */
const handled = new Set<string>();

function deliver(accountId: string, request: ProactiveRunRequest) {
  if (!registered) {
    pending = [...pending, { accountId, request }].slice(-MAX_PENDING);
    return;
  }
  if (registered.accountId !== accountId || handled.has(request.runId)) return;
  handled.add(request.runId);
  if (handled.size > MAX_REMEMBERED) handled.delete(handled.values().next().value as string);
  registered.handler(request);
}

/** Hands proactive run hints from `accountId`'s sync stream to this Mac. */
export function notifyProactiveRunRequests(
  events: ReadonlyArray<{ eventType?: string; payload?: unknown }>,
  accountId: string,
) {
  for (const event of events) {
    const request = parseProactiveRunRequest(event.eventType, event.payload);
    if (request) deliver(accountId, request);
  }
}

/**
 * Runs `handler` for each new proactive run of `accountId`, including hints
 * that arrived before the local runtime was ready. Returns the unregister.
 */
export function setProactiveRunRequestHandler(accountId: string, handler: Handler): () => void {
  const registration = { accountId, handler };
  registered = registration;
  const waiting = pending;
  pending = [];
  for (const entry of waiting) deliver(entry.accountId, entry.request);
  return () => { if (registered === registration) registered = null; };
}

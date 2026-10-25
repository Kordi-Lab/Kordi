/**
 * `proactive.proposal_changed` account hints. The server sends one to the
 * owner whenever one of their agents' proposals is created or changes status;
 * the open conversation's prompt uses it to show, update or hide the offer.
 */
export const PROACTIVE_PROPOSAL_CHANGED_EVENT = 'proactive.proposal_changed';

export type ProactiveProposalChange = {
  proposalId: string;
  agentId: string;
  conversationId: string | null;
  sessionId: string | null;
  status: string | null;
  payload: Record<string, unknown>;
};

type Listener = (change: ProactiveProposalChange) => void;
const listeners = new Set<Listener>();

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseProactiveProposalChange(payload: unknown): ProactiveProposalChange | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const proposalId = text(record.proposalId);
  const agentId = text(record.agentId);
  if (!proposalId || !agentId) return null;
  return {
    proposalId,
    agentId,
    conversationId: text(record.conversationId) || null,
    sessionId: text(record.sessionId) || null,
    status: text(record.status) || null,
    payload: record,
  };
}

/** Hands `proactive.proposal_changed` events from the cloud sync stream to the open prompts. */
export function notifyProactiveProposalEvents(events: ReadonlyArray<{ eventType?: string; payload?: unknown }>) {
  for (const event of events) {
    if (event.eventType !== PROACTIVE_PROPOSAL_CHANGED_EVENT) continue;
    const change = parseProactiveProposalChange(event.payload);
    if (!change) continue;
    for (const listener of [...listeners]) listener(change);
  }
}

export function subscribeProactiveProposalChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

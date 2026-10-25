/**
 * The `proactive_offer` content block an owned agent posts in its owner's
 * conversation when it wants to help in a group (docs/development/proactive-agent.md).
 * The server refreshes the block in place when the proposal's status changes.
 */
export type ProactiveOfferStatus = 'pending' | 'approved' | 'running' | 'done' | 'declined' | 'expired' | 'failed';

export type MessageProactiveOffer = {
  proposalId: string;
  agentId: string;
  agentName: string;
  conversationId: string | null;
  sessionId: string | null;
  conversationTitle: string;
  triggerMessageId: string | null;
  problem: string;
  offer: string;
  plan: string;
  status: ProactiveOfferStatus;
  expiresAt: string | null;
  runId: string | null;
  decidedAt: string | null;
};

export type ProactiveActivityEntry = {
  at: string;
  conversationId: string | null;
  conversationTitle: string;
  decision: 'offer' | 'silence';
  proposalId: string | null;
  status: ProactiveOfferStatus | null;
  problem: string | null;
  runId: string | null;
  error: string | null;
};

const STATUSES: readonly ProactiveOfferStatus[] = ['pending', 'approved', 'running', 'done', 'declined', 'expired', 'failed'];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableText(value: unknown): string | null {
  return text(value) || null;
}

export function normalizeProactiveOfferStatus(value: unknown): ProactiveOfferStatus | null {
  return STATUSES.includes(value as ProactiveOfferStatus) ? value as ProactiveOfferStatus : null;
}

/** Reads a `proactive_offer` block, or a stored copy of one. Returns null when it cannot be acted on. */
export function normalizeProactiveOffer(value: unknown): MessageProactiveOffer | null {
  const block = record(value);
  if (!block) return null;
  if (block.type !== undefined && block.type !== 'proactive_offer') return null;
  const proposalId = text(block.proposalId);
  const agentId = text(block.agentId);
  if (!proposalId || !agentId) return null;
  return {
    proposalId,
    agentId,
    agentName: text(block.agentName) || 'Your agent',
    conversationId: nullableText(block.conversationId),
    sessionId: nullableText(block.sessionId),
    conversationTitle: text(block.conversationTitle) || 'a group',
    triggerMessageId: nullableText(block.triggerMessageId),
    problem: text(block.problem),
    offer: text(block.offer),
    plan: text(block.plan),
    status: normalizeProactiveOfferStatus(block.status) ?? 'pending',
    expiresAt: nullableText(block.expiresAt),
    runId: nullableText(block.runId),
    decidedAt: nullableText(block.decidedAt),
  };
}

/** The first `proactive_offer` block of a chat message's content. */
export function proactiveOfferFromChatContent(content: unknown): MessageProactiveOffer | null {
  const blocks = record(content)?.blocks;
  if (!Array.isArray(blocks)) return null;
  for (const value of blocks) {
    if (record(value)?.type !== 'proactive_offer') continue;
    const offer = normalizeProactiveOffer(value);
    if (offer) return offer;
  }
  return null;
}

/** Applies a decision result (the proposal the server returns) to the card the owner sees. */
export function proactiveOfferWithProposal(offer: MessageProactiveOffer, proposal: unknown): MessageProactiveOffer {
  const source = record(proposal);
  const nested = record(source?.proposal) ?? source;
  if (!nested) return offer;
  return {
    ...offer,
    status: normalizeProactiveOfferStatus(nested.status) ?? offer.status,
    runId: nullableText(nested.runId) ?? offer.runId,
    decidedAt: nullableText(nested.decidedAt) ?? offer.decidedAt,
    expiresAt: nullableText(nested.expiresAt) ?? offer.expiresAt,
  };
}

export function normalizeProactiveActivity(value: unknown): ProactiveActivityEntry[] {
  const source = record(value);
  const entries = Array.isArray(value) ? value : Array.isArray(source?.activity) ? source.activity : [];
  return entries.flatMap((entry) => {
    const item = record(entry);
    const at = text(item?.at);
    if (!item || !at) return [];
    return [{
      at,
      conversationId: nullableText(item.conversationId),
      conversationTitle: text(item.conversationTitle) || 'Group',
      decision: item.decision === 'offer' ? 'offer' : 'silence',
      proposalId: nullableText(item.proposalId),
      status: normalizeProactiveOfferStatus(item.status),
      problem: nullableText(item.problem),
      runId: nullableText(item.runId),
      error: nullableText(item.error),
    } satisfies ProactiveActivityEntry];
  });
}

const ACTIVITY_STATUS_LABEL: Record<ProactiveOfferStatus, string> = {
  pending: 'Pending',
  approved: 'Allowed',
  running: 'Allowed',
  declined: 'Not now',
  expired: 'Expired',
  done: 'Done',
  failed: 'Failed',
};

export function relativeTimeLabel(at: string, now: number) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function proactiveActivityOutcome(entry: ProactiveActivityEntry) {
  if (entry.decision !== 'offer') return 'Stayed quiet';
  return entry.status ? `Offered · ${ACTIVITY_STATUS_LABEL[entry.status]}` : 'Offered';
}

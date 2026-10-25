/**
 * A proposal an owned agent makes when it wants to help in a group
 * (docs/development/proactive-agent.md). The owner sees it above the composer
 * of that group and allows or declines it; nobody else sees it.
 */
export type ProactiveOfferStatus = 'pending' | 'approved' | 'running' | 'done' | 'declined' | 'expired' | 'failed';

export type ProactiveProposal = {
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
  replyMessageId: string | null;
  error: string | null;
  createdAt: string | null;
};

/** The server's verdict for one evaluation; unknown values read as `silence`. */
export type ProactiveActivityDecision = 'offer' | 'silence' | 'failed' | 'cancelled' | 'pending';

export type ProactiveActivityEntry = {
  at: string;
  conversationId: string | null;
  conversationTitle: string;
  decision: ProactiveActivityDecision;
  proposalId: string | null;
  status: ProactiveOfferStatus | null;
  problem: string | null;
  runId: string | null;
  error: string | null;
};

const DECISIONS: readonly ProactiveActivityDecision[] = ['offer', 'silence', 'failed', 'cancelled', 'pending'];

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

/** Reads one proposal from the server. Returns null when it cannot be acted on. */
export function normalizeProactiveProposal(value: unknown): ProactiveProposal | null {
  const source = record(value);
  if (!source) return null;
  const proposalId = text(source.proposalId);
  const agentId = text(source.agentId);
  if (!proposalId || !agentId) return null;
  return {
    proposalId,
    agentId,
    agentName: text(source.agentName) || 'Your agent',
    conversationId: nullableText(source.conversationId),
    sessionId: nullableText(source.sessionId),
    conversationTitle: text(source.conversationTitle) || 'a group',
    triggerMessageId: nullableText(source.triggerMessageId),
    problem: text(source.problem),
    offer: text(source.offer),
    plan: text(source.plan),
    status: normalizeProactiveOfferStatus(source.status) ?? 'pending',
    expiresAt: nullableText(source.expiresAt),
    runId: nullableText(source.runId),
    decidedAt: nullableText(source.decidedAt),
    replyMessageId: nullableText(source.replyMessageId),
    error: nullableText(source.error),
    createdAt: nullableText(source.createdAt),
  };
}

/** Whether a proposal can no longer be allowed, by status or by its expiry time. */
export function proactiveProposalExpired(proposal: ProactiveProposal, now: number) {
  const at = proposal.expiresAt ? Date.parse(proposal.expiresAt) : Number.NaN;
  return proposal.status === 'expired' || (proposal.status === 'pending' && Number.isFinite(at) && at <= now);
}

/** Reads `{ proposals: [...] }` or a bare list. */
export function normalizeProactiveProposals(value: unknown): ProactiveProposal[] {
  const entries = Array.isArray(value) ? value : record(value)?.proposals;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const proposal = normalizeProactiveProposal(entry);
    return proposal ? [proposal] : [];
  });
}

/**
 * Applies a decision result or a `proactive.proposal_changed` payload to a
 * proposal the owner already sees. Fields the update leaves out keep their value.
 */
export function proactiveProposalWithUpdate(proposal: ProactiveProposal, update: unknown): ProactiveProposal {
  const source = record(update);
  const nested = record(source?.proposal) ?? source;
  if (!nested) return proposal;
  return {
    ...proposal,
    status: normalizeProactiveOfferStatus(nested.status) ?? proposal.status,
    problem: text(nested.problem) || proposal.problem,
    offer: text(nested.offer) || proposal.offer,
    plan: text(nested.plan) || proposal.plan,
    runId: nullableText(nested.runId) ?? proposal.runId,
    decidedAt: nullableText(nested.decidedAt) ?? proposal.decidedAt,
    expiresAt: nullableText(nested.expiresAt) ?? proposal.expiresAt,
    replyMessageId: nullableText(nested.replyMessageId) ?? proposal.replyMessageId,
    error: nullableText(nested.error) ?? proposal.error,
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
      decision: DECISIONS.includes(item.decision as ProactiveActivityDecision) ? item.decision as ProactiveActivityDecision : 'silence',
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

/** The Runs tab's sentence-case label for one evaluation. A failed one names its error code. */
export function proactiveActivityOutcome(entry: ProactiveActivityEntry) {
  switch (entry.decision) {
    case 'offer': return entry.status ? `Offered · ${ACTIVITY_STATUS_LABEL[entry.status]}` : 'Offered';
    case 'failed': return entry.error ? `Could not evaluate · ${entry.error}` : 'Could not evaluate';
    case 'cancelled': return 'Cancelled';
    case 'pending': return 'Evaluating';
    default: return 'Stayed quiet';
  }
}

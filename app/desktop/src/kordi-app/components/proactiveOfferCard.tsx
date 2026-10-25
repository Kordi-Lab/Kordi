import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { ProactiveDecision } from '@/features/cloud/proactiveClient';
import { proactiveProposalExpired, type ProactiveProposal } from '@/features/cloud/proactiveOffer';

export type ProactiveOfferDecide = (proposal: ProactiveProposal, decision: ProactiveDecision) => Promise<unknown>;

function expiresLabel(expiresAt: string | null, now: number): string | null {
  const at = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return `Expires in ${Math.max(1, Math.ceil((at - now) / 3_600_000))}h`;
}

/**
 * An owned agent's offer to help, shown to its owner above the composer of
 * the conversation where the problem came up.
 */
export function ProactiveOfferCard({
  proposal,
  decide,
  now: nowOverride,
}: {
  proposal: ProactiveProposal;
  decide: ProactiveOfferDecide;
  now?: number;
}) {
  const [renderedAt] = useState(() => Date.now());
  const now = nowOverride ?? renderedAt;
  const [busy, setBusy] = useState<ProactiveDecision | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = proactiveProposalExpired(proposal, now) ? 'expired' : proposal.status;
  const title = `${proposal.agentName} can help here`;

  const act = async (decision: ProactiveDecision) => {
    if (busy) return;
    setBusy(decision);
    setNotice(null);
    try {
      await decide(proposal, decision);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not update this offer.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="app-plan-card app-proactive-offer" data-kordi-copy-surface="message" data-proactive-offer-status={status} aria-label={title}>
      <div className="app-plan-card-head">
        <Sparkles size={14} aria-hidden className="app-plan-card-icon" />
        <div className="app-plan-card-heading">
          <div className="app-plan-card-title">{title}</div>
          {proposal.problem ? <div className="app-proactive-offer-problem">{proposal.problem}</div> : null}
        </div>
      </div>
      {proposal.offer ? <blockquote className="app-proactive-offer-quote">{proposal.offer}</blockquote> : null}
      {proposal.plan ? <div className="app-proactive-offer-plan">{proposal.plan}</div> : null}
      {status === 'pending' ? (
        <div className="app-proactive-offer-footer">
          <span className="app-proactive-offer-muted">{expiresLabel(proposal.expiresAt, now)}</span>
          <div className="app-plan-card-actions">
            <button type="button" className="app-plan-card-button" disabled={Boolean(busy)} onClick={() => { void act('decline'); }}>Not now</button>
            <button type="button" className="app-plan-card-button app-plan-card-button-primary" disabled={Boolean(busy)} onClick={() => { void act('allow'); }}>Allow</button>
          </div>
        </div>
      ) : (
        <div className={cn('app-proactive-offer-state', status === 'failed' && 'app-plan-card-notice')} role="status">
          {status === 'approved' || status === 'running' ? 'Working…' : null}
          {status === 'expired' ? 'Expired' : null}
          {status === 'failed' ? 'Could not finish' : null}
        </div>
      )}
      {notice ? <div className="app-plan-card-notice" role="alert">{notice}</div> : null}
    </section>
  );
}

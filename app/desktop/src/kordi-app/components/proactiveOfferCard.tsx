import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { loadSession } from '@/features/cloud/session';
import { decideProactiveProposal, type ProactiveDecision } from '@/features/cloud/proactiveClient';
import { proactiveOfferWithProposal, type MessageProactiveOffer } from '@/features/cloud/proactiveOffer';
import { dispatchDocumentSessionOpen } from '@/features/documents/documentShareToken';

export type ProactiveOfferDecide = (offer: MessageProactiveOffer, decision: ProactiveDecision) => Promise<unknown>;

async function decideAsOwner(offer: MessageProactiveOffer, decision: ProactiveDecision) {
  const session = await loadSession();
  if (!session?.token) throw new Error('Sign in to respond.');
  return decideProactiveProposal(session.token, offer.agentId, offer.proposalId, decision);
}

function expiresLabel(expiresAt: string | null, now: number): string | null {
  const at = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return `Expires in ${Math.max(1, Math.ceil((at - now) / 3_600_000))}h`;
}

function expired(offer: MessageProactiveOffer, now: number) {
  const at = offer.expiresAt ? Date.parse(offer.expiresAt) : Number.NaN;
  return offer.status === 'expired' || (offer.status === 'pending' && Number.isFinite(at) && at <= now);
}

/**
 * The card an owned agent posts in its owner's conversation when it wants to
 * help in a group. The server refreshes the block in place on every status
 * change; a decision shows the returned status until that refresh arrives.
 */
export function ProactiveOfferCard({
  offer,
  decide = decideAsOwner,
  openSession = dispatchDocumentSessionOpen,
  now: nowOverride,
}: {
  offer: MessageProactiveOffer;
  decide?: ProactiveOfferDecide;
  openSession?: (sessionId: string) => void;
  now?: number;
}) {
  const [renderedAt] = useState(() => Date.now());
  const now = nowOverride ?? renderedAt;
  const [busy, setBusy] = useState<ProactiveDecision | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [local, setLocal] = useState<{ base: MessageProactiveOffer; next: MessageProactiveOffer } | null>(null);
  const view = local && local.base.proposalId === offer.proposalId && local.base.status === offer.status ? local.next : offer;
  const status = expired(view, now) ? 'expired' : view.status;
  const title = view.conversationTitle;

  const act = async (decision: ProactiveDecision) => {
    if (busy) return;
    setBusy(decision);
    setNotice(null);
    try {
      const proposal = await decide(view, decision);
      const fallback = { ...view, status: decision === 'allow' ? 'approved' : 'declined' } as MessageProactiveOffer;
      setLocal({ base: offer, next: proactiveOfferWithProposal(fallback, proposal) });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not update this offer.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="app-plan-card app-proactive-offer" data-kordi-copy-surface="message" data-proactive-offer-status={status} aria-label={`${view.agentName} can help in ${title}`}>
      <div className="app-plan-card-head">
        <Sparkles size={14} aria-hidden className="app-plan-card-icon" />
        <div className="app-plan-card-heading">
          <div className="app-plan-card-title">{view.agentName} can help in {title}</div>
          {view.problem ? <div className="app-proactive-offer-problem">{view.problem}</div> : null}
        </div>
      </div>
      {view.offer ? <blockquote className="app-proactive-offer-quote">{view.offer}</blockquote> : null}
      {view.plan ? <div className="app-proactive-offer-plan">{view.plan}</div> : null}
      {status === 'pending' ? (
        <div className="app-proactive-offer-footer">
          <span className="app-proactive-offer-muted">{expiresLabel(view.expiresAt, now)}</span>
          <div className="app-plan-card-actions">
            <button type="button" className="app-plan-card-button" disabled={Boolean(busy)} onClick={() => { void act('decline'); }}>Not now</button>
            <button type="button" className="app-plan-card-button app-plan-card-button-primary" disabled={Boolean(busy)} onClick={() => { void act('allow'); }}>Allow</button>
          </div>
        </div>
      ) : (
        <div className={cn('app-proactive-offer-state', status === 'failed' && 'app-plan-card-notice')} role="status">
          {status === 'approved' || status === 'running' ? `Working in ${title}…` : null}
          {status === 'done' ? (
            <>
              Replied in {title}
              {view.sessionId ? <button type="button" className="app-proactive-offer-open" onClick={() => openSession(view.sessionId!)}>Open</button> : null}
            </>
          ) : null}
          {status === 'declined' ? 'Not now' : null}
          {status === 'expired' ? 'Expired' : null}
          {status === 'failed' ? 'Could not finish' : null}
        </div>
      )}
      {notice ? <div className="app-plan-card-notice" role="alert">{notice}</div> : null}
    </section>
  );
}

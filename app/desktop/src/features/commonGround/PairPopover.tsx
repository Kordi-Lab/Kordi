import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Copy } from 'lucide-react';

import { pairLinkUrl } from './pairLink';
import { PairQr } from './PairQr';
import { CgPairSession, pairTimeLeft } from './pairSession';
import type { CommonGroundStore } from './store';
import { PAIR_SHARING_OFF } from './storePairing';
import { usePopoverDismiss } from './usePopoverDismiss';

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function PairBody({ session, store, onClose }: { session: CgPairSession; store: CommonGroundStore; onClose: () => void }) {
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [theirs, setTheirs] = useState('');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const copied = Boolean(view.code) && copiedCode === view.code;
  const now = useNow(view.phase === 'ready');
  useEffect(() => { if (view.phase === 'closed') onClose(); }, [view.phase, onClose]);

  const turnOn = async () => {
    await store.setSharing(true);
    if (store.getSnapshot().owner?.sharing) void session.refresh();
  };

  if (view.phase === 'sharing-off') {
    return (
      <>
        <div className="cg-pop-title">Pair</div>
        <p className="cg-pair-off">{PAIR_SHARING_OFF}</p>
        <div className="cg-pop-foot">
          <button type="button" className="cg-mbtn is-primary" disabled={store.getSnapshot().busy === 'sharing'} onClick={() => void turnOn()}>Turn on sharing</button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="cg-pair-show">
        <PairQr value={view.code ? pairLinkUrl(view.code) : null} />
        <div className="cg-pair-code">
          <span aria-live="polite">{view.code ?? '····-····'}</span>
          <button
            type="button"
            className="cg-pair-copy"
            aria-label={copied ? 'Copied' : 'Copy code'}
            title={copied ? 'Copied' : 'Copy code'}
            disabled={!view.code}
            onClick={() => {
              const code = view.code;
              if (code) void navigator.clipboard?.writeText(code).then(() => setCopiedCode(code), () => undefined);
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>
        </div>
        {view.phase === 'failed' ? (
          <div className="cg-pair-sub is-error" role="alert">
            {view.loadError}
            <button type="button" className="cg-pair-retry" onClick={() => void session.refresh()}>Try again</button>
          </div>
        ) : (
          <div className="cg-pair-sub">{view.expiresAt ? `Valid for ${pairTimeLeft(view.expiresAt - now)}` : 'Getting your code'}</div>
        )}
      </div>
      <form
        className="cg-pair-their"
        onSubmit={(event) => {
          event.preventDefault();
          void session.redeem(theirs);
        }}
      >
        <label className="cg-pop-label" htmlFor="cg-pair-their">Their code</label>
        <div className="cg-pair-field">
          <input
            id="cg-pair-their"
            autoFocus
            className="cg-pop-input"
            value={theirs}
            placeholder="XXXX-XXXX"
            maxLength={12}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={view.redeeming}
            aria-invalid={view.error ? true : undefined}
            onChange={(event) => {
              setTheirs(event.target.value.toUpperCase());
              session.clearError();
            }}
          />
          <button type="submit" className="cg-mbtn is-primary" disabled={view.redeeming || !theirs.trim()}>Pair</button>
        </div>
        {view.error ? <div className="cg-pop-error" role="alert">{view.error}</div> : null}
      </form>
    </>
  );
}

/**
 * Pair: a 320px popover under the Pair row. Your code as a QR code and as text, renewed shortly
 * before it runs out, and a field for their code that opens the match.
 */
export function PairPopover({ store, onClose }: { store: CommonGroundStore; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [session] = useState(() => new CgPairSession({ create: () => store.newPairCode(), redeem: (code) => store.redeemPairCode(code) }));
  usePopoverDismiss(ref, '[data-cg-pair]', onClose);
  useEffect(() => {
    void session.start();
    return () => session.stop();
  }, [session]);
  return (
    <div ref={ref} className="cg-pop cg-pair-pop" role="dialog" aria-label="Pair">
      <PairBody session={session} store={store} onClose={onClose} />
    </div>
  );
}

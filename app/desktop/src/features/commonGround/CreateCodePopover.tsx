import { useRef, useState } from 'react';
import { Check, Share } from 'lucide-react';

import { cn } from '@/lib/utils';
import { CardGlyph, CardSwatch } from './ProfileCard';
import type { CgCardDesign, CgCardIcon } from './cardDesign';
import type { CgProfileKind, CgRoom } from './types';
import { usePopoverDismiss } from './usePopoverDismiss';

export const MEETUP_NAME_MAX = 80;

export type CgShareChoice = { id: string; name: string; design: CgCardDesign; icon?: CgCardIcon | null; kind?: CgProfileKind };

/**
 * Create a code: a 320px popover under the Pair code row. Name the meetup, pick the card to
 * share (the current one first), Create; then the new code, large, with Enter room and Share this code.
 */
export function CreateCodePopover({ cards, current, busy, notice, onCreate, onEnter, onClose }: {
  cards: CgShareChoice[];
  current: string | null;
  busy: boolean;
  notice: string | null;
  onCreate: (name: string, cardId: string) => Promise<CgRoom | null>;
  onEnter: (code: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [cardId, setCardId] = useState(cards.some((card) => card.id === current) ? current! : cards[0]?.id ?? '');
  const [created, setCreated] = useState<{ code: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const card = cards.find((item) => item.id === cardId);
  const ready = Boolean(name.trim() && card && !busy);

  usePopoverDismiss(ref, '[data-cg-create]', onClose);

  const submit = async () => {
    if (!ready || !card) return;
    const room = await onCreate(name, card.id);
    setFailed(!room);
    if (room) setCreated({ code: room.code, name: room.name || name.trim() });
  };

  return (
    <div ref={ref} className="cg-pop" role="dialog" aria-label={created ? 'Your code' : 'Create a code'}>
      {created && card ? (
        <>
          <div className="cg-code-big" aria-label={`Code ${created.code.split('').join(' ')}`}>
            {created.code.split('').map((digit, index) => <span key={index}>{digit}</span>)}
          </div>
          <div className="cg-code-name">{created.name}</div>
          <div className="cg-code-sub"><CardSwatch design={card.design} className="is-chip" />Sharing {card.name}</div>
          <button type="button" className="cg-mbtn is-primary is-wide" onClick={() => onEnter(created.code)}>Enter room</button>
          <button
            type="button"
            className="cg-mbtn is-wide"
            onClick={() => {
              void navigator.clipboard?.writeText(created.code).then(() => setCopied(true), () => undefined);
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Share className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? 'Copied' : 'Share this code'}
          </button>
        </>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="cg-pop-title">Create a code</div>
          <input
            autoFocus
            className="cg-pop-input"
            value={name}
            placeholder="Meetup name"
            aria-label="Meetup name"
            maxLength={MEETUP_NAME_MAX}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
          <div className="cg-pop-label">Share</div>
          <div className="cg-pop-cards" role="radiogroup" aria-label="Card">
            {cards.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={item.id === cardId}
                aria-label={item.name}
                title={item.name}
                className={cn('cg-pop-card', item.id === cardId && 'is-on')}
                data-design={item.design}
                onClick={() => setCardId(item.id)}
              >
                <CardGlyph design={item.design} icon={item.icon} kind={item.kind} />
              </button>
            ))}
            {card ? <span className="cg-pop-pick">{card.name}</span> : null}
          </div>
          {failed && notice ? <div className="cg-pop-error" role="alert">{notice}</div> : null}
          <div className="cg-pop-foot">
            <button type="submit" className="cg-mbtn is-primary" disabled={!ready}>Create</button>
          </div>
        </form>
      )}
    </div>
  );
}

import { useId, useState } from 'react';
import { X } from 'lucide-react';

import { AppDialog, AppDialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { CARD_DESIGNS, canCreateCard, designEntry, firstFreeDesign, newCardDraft, type CgNewCardDraft } from './cardDesign';
import { CgNotice } from './parts';
import { CardGlyph, ProfileCardLarge } from './ProfileCard';
import { PROFILE_FOCUS_MAX, PROFILE_NAME_MAX } from './profiles';
import type { CgProfileKind } from './types';

/**
 * New card: six design swatches above a live card that the name and focus are typed into.
 * Fixed kinds already in the wallet show "In your wallet" and cannot be created again.
 */
export function NewCardDialog({ taken, busy, notice, onCancel, onCreate }: {
  taken: CgProfileKind[];
  busy: boolean;
  notice: string | null;
  onCancel: () => void;
  onCreate: (draft: CgNewCardDraft) => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState<CgNewCardDraft>(() => newCardDraft(firstFreeDesign(taken)));
  const entry = designEntry(draft.design);
  const inWallet = taken.includes(entry.kind);
  const ready = !busy && canCreateCard(draft, taken);
  const pick = (index: number) => {
    const next = CARD_DESIGNS[Math.max(0, Math.min(CARD_DESIGNS.length - 1, index))];
    setDraft((current) => newCardDraft(next.design, current));
    return next.design;
  };
  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-dialog cg-newcard">
      <form onSubmit={(event) => { event.preventDefault(); if (ready) onCreate(draft); }}>
        <div className="cg-newcard-head">
          <AppDialogTitle id={titleId} className="cg-newcard-title">New card</AppDialogTitle>
          <button type="button" className="cg-newcard-x" aria-label="Close" onClick={onCancel} disabled={busy}>
            <X className="h-[15px] w-[15px]" aria-hidden="true" />
          </button>
        </div>
        <div className="cg-newcard-body">
          <div className="cg-designs" role="radiogroup" aria-label="Design">
            {CARD_DESIGNS.map((item, index) => {
              const on = item.design === draft.design;
              return (
                <button
                  key={item.design}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={item.label}
                  title={item.label}
                  tabIndex={on ? 0 : -1}
                  data-design={item.design}
                  className={cn('cg-design', on && 'is-on', taken.includes(item.kind) && 'is-taken')}
                  onClick={() => pick(index)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    const design = pick(index + (event.key === 'ArrowRight' ? 1 : -1));
                    const parent = event.currentTarget.parentElement;
                    requestAnimationFrame(() => parent?.querySelector<HTMLElement>(`[data-design="${design}"]`)?.focus());
                  }}
                >
                  <CardGlyph design={item.design} />
                </button>
              );
            })}
          </div>
          <div className="cg-design-label">{entry.label}</div>
          <div className="cg-newcard-preview">
            <ProfileCardLarge
              key={draft.design}
              face={{ design: draft.design, name: draft.name, focus: draft.focus, topicCount: 0, status: 'empty' }}
              badge={inWallet ? 'In your wallet' : undefined}
              edit={{
                namePlaceholder: entry.kind === 'custom' ? 'Name' : entry.label,
                disabled: inWallet || busy,
                nameMax: PROFILE_NAME_MAX,
                focusMax: PROFILE_FOCUS_MAX,
                onName: (name) => setDraft((current) => ({ ...current, name })),
                onFocus: (focus) => setDraft((current) => ({ ...current, focus })),
              }}
            />
          </div>
          <CgNotice text={notice} />
        </div>
        <div className="cg-newcard-foot">
          <button type="button" className="cg-mbtn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="cg-mbtn is-primary" disabled={!ready}>Create</button>
        </div>
      </form>
    </AppDialog>
  );
}

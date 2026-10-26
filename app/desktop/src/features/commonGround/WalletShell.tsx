import { useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

import { cn } from '@/lib/utils';
import { newCardInput } from './cardDesign';
import { DeckRail } from './DeckRail';
import { NewCardDialog } from './NewCardDialog';
import { CardSwatch, type CgCardFace, type CgCardOwner } from './ProfileCard';
import { MAX_PROFILES, takenKinds } from './profiles';
import { currentProfile, type CgState, type CommonGroundStore } from './store';
import { deckCards, profileFace } from './wallet';

type Chip = { key: string; face: CgCardFace };

/** "Sharing: Work" in the page header; a new card crossfades over the old one. */
export function SharingChip({ chipKey, face }: { chipKey: string; face: CgCardFace }) {
  const [shown, setShown] = useState<Chip>({ key: chipKey, face });
  const [leaving, setLeaving] = useState<Chip | null>(null);
  if (shown.key !== chipKey) {
    setLeaving(shown);
    setShown({ key: chipKey, face });
  } else if (shown.face.name !== face.name || shown.face.design !== face.design || shown.face.icon !== face.icon) {
    setShown({ key: chipKey, face });
  }
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = setTimeout(() => setLeaving(null), 220);
    return () => clearTimeout(timer);
  }, [leaving]);
  const chip = (item: Chip, out: boolean) => (
    <span key={`${item.key}${out ? ':out' : ''}`} className={out ? 'cg-share-chip is-out' : 'cg-share-chip is-in'} aria-hidden={out || undefined}>
      <CardSwatch design={item.face.design} className="is-chip" />
      <span>Sharing: <b>{item.face.name}</b></span>
    </span>
  );
  return (
    <span className="cg-share-chips" aria-live="polite">
      {leaving ? chip(leaving, true) : null}
      {chip(shown, false)}
    </span>
  );
}

/**
 * Grounding Home and the card page on the Mac: a header (back, title, the shared card) above
 * the deck rail and one centre column.
 */
export function WalletShell({ state, store, owner, title, onBack, chip, actions, center = false, children }: {
  state: CgState;
  store: CommonGroundStore;
  /** The signed-in account, drawn on its cards. */
  owner?: CgCardOwner;
  title: string;
  onBack?: () => void;
  /** Replaces the "Sharing" chip of the current card (Nearby shares its own card). */
  chip?: ReactNode;
  /** Buttons after the chip, such as Nearby's More menu. */
  actions?: ReactNode;
  /** Centres the column's content, as for Nearby before it is on. */
  center?: boolean;
  children: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const profile = currentProfile(state);
  const cards = state.profilesOn ? deckCards(state, owner) : [];
  const page = state.stack[state.stack.length - 1]?.name ?? 'home';
  const onCard = page === 'card';
  const select = (id: string) => {
    if (id === 'suggested') return;
    const target = state.profiles.find((item) => item.profileId === id);
    if (id !== state.profileId) void store.selectProfile(id);
    if (onCard && !target?.hasCard) store.back();
  };
  const openCard = (id: string) => {
    if (id !== state.profileId) void store.selectProfile(id);
    if (!onCard) store.open({ name: 'card' });
  };
  return (
    <div className="cg-wallet">
      <header className="cg-wallet-head">
        {onBack ? (
          <button type="button" className="cg-wallet-back" aria-label="Back" onClick={onBack}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        <h1>{title}</h1>
        {chip !== undefined ? chip : profile ? <SharingChip chipKey={profile.profileId} face={profileFace(profile, state)} /> : null}
        {actions}
      </header>
      <div className={state.profilesOn ? 'cg-wallet-body' : 'cg-wallet-body is-plain'}>
        {state.profilesOn ? (
          <DeckRail
            cards={cards}
            selected={state.profiles.length ? state.profileId : 'suggested'}
            canAdd={state.profiles.length < MAX_PROFILES}
            onSelect={select}
            onOpen={openCard}
            onNew={() => setCreating(true)}
          />
        ) : null}
        <div className={center ? 'cg-wallet-main is-center' : 'cg-wallet-main'}>
          <div key={`${page}:${onCard ? state.profileId : ''}`} className={cn('cg-wallet-col', page !== 'home' && 'is-push', page === 'nearby' && 'is-nearby')}>
            {children}
          </div>
        </div>
      </div>
      {creating ? (
        <NewCardDialog
          taken={takenKinds(state.profiles)}
          owner={owner}
          busy={state.busy === 'profile'}
          notice={state.notice}
          onCancel={() => setCreating(false)}
          onCreate={(draft) => void store.createProfile(newCardInput(draft)).then((ok) => {
            if (ok) setCreating(false);
          })}
        />
      ) : null}
    </div>
  );
}

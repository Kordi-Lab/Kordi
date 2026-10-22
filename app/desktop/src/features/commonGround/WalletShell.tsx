import { useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

import { localDesignMemory, designEntry, newCardInput } from './cardDesign';
import { DeckRail } from './DeckRail';
import { NewCardDialog } from './NewCardDialog';
import { CardSwatch, type CgCardFace } from './ProfileCard';
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
  } else if (shown.face.name !== face.name || shown.face.design !== face.design) {
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
export function WalletShell({ state, store, title, onBack, children }: {
  state: CgState;
  store: CommonGroundStore;
  title: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const profile = currentProfile(state);
  const cards = state.profilesOn ? deckCards(state) : [];
  const onCard = state.stack[state.stack.length - 1]?.name === 'card';
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
        {profile ? <SharingChip chipKey={profile.profileId} face={profileFace(profile, state)} /> : null}
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
        <div className="cg-wallet-main">
          <div key={`${onCard ? 'card' : 'home'}:${onCard ? state.profileId : ''}`} className={onCard ? 'cg-wallet-col is-push' : 'cg-wallet-col'}>
            {children}
          </div>
        </div>
      </div>
      {creating ? (
        <NewCardDialog
          taken={takenKinds(state.profiles)}
          busy={state.busy === 'profile'}
          notice={state.notice}
          onCancel={() => setCreating(false)}
          onCreate={(draft) => void store.createProfile(newCardInput(draft)).then((ok) => {
            if (!ok) return;
            const id = store.getSnapshot().profileId;
            if (id && designEntry(draft.design).kind === 'custom') localDesignMemory.write(id, draft.design);
            setCreating(false);
          })}
        />
      ) : null}
    </div>
  );
}

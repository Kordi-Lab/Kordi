import { useState } from 'react';
import { ChevronRight, MapPin } from 'lucide-react';

import { nearbyRowSub } from './nearbyFormat';
import { currentProfile, type CgState, type CommonGroundStore } from './store';
import { useNearby } from './useNearby';

/** Opens Nearby with the card on this home page, using the latest device location. */
export function NearbyRow({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const [nb, nearby] = useNearby(store);
  const [opening, setOpening] = useState(false);
  const profile = currentProfile(state);
  const sameCard = nb.settings?.profileId === profile?.profileId;
  const phase = nearby.phase();
  const people = sameCard && nb.results ? nb.results.people.filter((entry) => entry.status !== 'matching').length : null;
  const sub = opening ? 'Opening Nearby…' : !sameCard && profile ? `Find people for ${profile.name}` : nb.loaded ? nearbyRowSub(phase, nb.settings, people) : null;
  const open = async () => {
    if (opening) return;
    if (!profile?.hasCard) { store.open({ name: 'build' }); return; }
    setOpening(true);
    store.set({ notice: null });
    try {
      if (!nb.loaded && !await nearby.loadSettings()) {
        store.set({ notice: nearby.getSnapshot().notice });
        return;
      }
      const settings = nearby.getSnapshot().settings;
      if (settings?.enabled && settings.profileId !== profile.profileId && !await nearby.setProfile(profile.profileId)) {
        store.set({ notice: nearby.getSnapshot().notice });
        return;
      }
      if (store.getSnapshot().profileId === profile.profileId) store.open({ name: 'nearby' });
    } finally { setOpening(false); }
  };
  return (
    <button type="button" className="cg-pair-row cg-nb-row" data-cg-nearby="true" disabled={opening} onClick={() => void open()}>
      <span className="cg-pair-icon is-amber" aria-hidden="true"><MapPin className="h-[15px] w-[15px]" /></span>
      <span className="cg-mrow-text">
        <span className="cg-pair-title">Nearby</span>
        {sub ? <span className="cg-mrow-sub">{sub}</span> : null}
      </span>
      <ChevronRight className="cg-mrow-chev" aria-hidden="true" />
    </button>
  );
}

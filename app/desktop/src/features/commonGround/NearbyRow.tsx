import { ChevronRight, MapPin } from 'lucide-react';

import { nearbyRowSub } from './nearbyFormat';
import type { CommonGroundStore } from './store';
import { useNearby } from './useNearby';

/** The Nearby row in the Pair panel: who is around now, from the location the iPhone sent. */
export function NearbyRow({ store }: { store: CommonGroundStore }) {
  const [nb, nearby] = useNearby(store);
  const phase = nearby.phase();
  const people = nb.results ? nb.results.people.filter((entry) => entry.status !== 'matching').length : null;
  const sub = nb.loaded ? nearbyRowSub(phase, nb.settings, people) : null;
  return (
    <button type="button" className="cg-pair-row cg-nb-row" data-cg-nearby="true" onClick={() => store.open({ name: 'nearby' })}>
      <span className="cg-pair-icon is-amber" aria-hidden="true"><MapPin className="h-[15px] w-[15px]" /></span>
      <span className="cg-mrow-text">
        <span className="cg-pair-title">Nearby</span>
        {sub ? <span className="cg-mrow-sub">{sub}</span> : null}
      </span>
      <ChevronRight className="cg-mrow-chev" aria-hidden="true" />
    </button>
  );
}

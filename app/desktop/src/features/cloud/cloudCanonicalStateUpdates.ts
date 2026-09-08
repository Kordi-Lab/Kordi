import type { CanonicalSessionStateSetter, CanonicalSessionStateUpdate } from './cloudGroupControlContext';

export function createCloudCanonicalStateUpdates(
  scopeId: string | null = null,
) {
  let pending: CanonicalSessionStateUpdate[] = [];
  let active = true;
  let generation = 0;
  return {
    scopeId,
    isActive: () => active,
    activate: () => {
      active = true;
    },
    publish: (update: CanonicalSessionStateUpdate) => {
      if (!active) return;
      pending.push(update);
    },
    flush: (setState: CanonicalSessionStateSetter) => {
      if (!active || pending.length === 0) return;
      const updates = pending;
      const currentGeneration = generation;
      pending = [];
      // Reapply the same deltas to React's latest state. Hydration or another
      // replay worker may have added rows since the ref was last read.
      setState((current) => active && generation === currentGeneration
        ? updates.reduce((state, update) => update(state), current)
        : current);
    },
    dispose: () => {
      active = false;
      generation += 1;
      pending = [];
    },
  };
}

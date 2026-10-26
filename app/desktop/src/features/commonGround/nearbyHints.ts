/**
 * `common_ground.nearby.updated` (settings, requests or results changed) and
 * `common_ground.nearby.alert` (an alert was delivered) account hints. Open
 * Nearby views refetch when one arrives. This module stays tiny: the sync
 * stream imports it outside the lazy Grounding page.
 */
export const NEARBY_HINT_TYPES: ReadonlySet<string> = new Set(['common_ground.nearby.updated', 'common_ground.nearby.alert']);

type Listener = () => void;
const listeners = new Set<Listener>();

/** Hands nearby hints from the cloud sync stream to open Nearby views, once per batch. */
export function notifyCommonGroundNearbyEvents(events: ReadonlyArray<{ eventType?: string }>) {
  if (!events.some((event) => event.eventType && NEARBY_HINT_TYPES.has(event.eventType))) return;
  for (const listener of [...listeners]) listener();
}

export function subscribeNearbyHints(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

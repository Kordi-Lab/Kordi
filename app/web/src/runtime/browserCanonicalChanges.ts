import type { CanonicalSessionState } from '@/kordi-app/types';
import { canonicalJsonValuesEqual } from '@/features/canonical/canonicalEquality';

// Commands that edit stored rows in place. A successful call always counts as a
// change; every other command replaces the collections it changes.
const IN_PLACE_COMMANDS = new Set([
  'desktop_canonical_update_message_delivery',
  'desktop_canonical_rename_session',
  'desktop_canonical_update_session_metadata',
  'desktop_canonical_remove_session_participant',
  'desktop_canonical_set_session_participant_role',
  'desktop_canonical_mark_session_read',
]);
const TRACKED_FIELDS = ['profile', 'identities', 'sessions', 'participants', 'messages',
  'delegatedExchanges', 'presence', 'contextSnapshots'] as const;

/** Whether two stored rows match apart from their write timestamp. */
export function browserCanonicalRowsMatch(previous: object | undefined, next: object): boolean {
  return Boolean(previous) && canonicalJsonValuesEqual({ ...previous, updatedAtMs: 0 }, { ...next, updatedAtMs: 0 });
}

/**
 * Runs a projection command and reports whether it changed the stored state, so
 * an idempotent replay neither rewrites storage nor wakes the canonical store.
 */
export function browserCanonicalCommandChanged<R>(state: CanonicalSessionState, command: string, apply: () => R) {
  const before = TRACKED_FIELDS.map(key => state[key]);
  const result = apply();
  const changed = IN_PLACE_COMMANDS.has(command) || TRACKED_FIELDS.some((key, index) => state[key] !== before[index]);
  return { result, changed };
}

/** Rows of the previous render that the activation plan compares against. */
export interface ActivationSnapshot {
  sessionKey: string;
  /** Request ids that were drawn as queued bubbles (in-memory or synced). */
  queuedIds: ReadonlySet<string>;
  /** Ids of every timeline row. */
  rowIds: ReadonlySet<string>;
  /** How many live processing rows were drawn. */
  processingCount: number;
}

export interface ActivationRow {
  /** Stable row id used to remember that the row has animated. */
  id: string;
  /** Every id the row is known by (message id, entry id, reply aliases). */
  aliases: readonly string[];
  /** True when the row is drawn as a queued bubble in this render. */
  queued: boolean;
  /** True for the owned-agent turn row that shows live progress. */
  processing: boolean;
}

/**
 * Pick the rows that should play the activate animation: a request that was a
 * queued bubble last render and is a sent bubble now, and a processing row that
 * newly appeared. A processing row that only replaces another one (the stored
 * reply taking over from the pending row under a new id) is not new: only as
 * many new processing rows animate as the live count grew. Nothing animates on
 * the first render of a session, and a row that already animated never
 * animates again.
 */
export function planActivationMotion(
  previous: ActivationSnapshot | null,
  sessionKey: string,
  rows: readonly ActivationRow[],
  animatedIds: ReadonlySet<string>,
): string[] {
  if (!previous || previous.sessionKey !== sessionKey) return [];
  const ids: string[] = [];
  for (const row of rows) {
    if (animatedIds.has(row.id)) continue;
    if (!row.queued && row.aliases.some((alias) => previous.queuedIds.has(alias))) ids.push(row.id);
  }
  const grownBy = rows.filter((row) => row.processing).length - previous.processingCount;
  if (grownBy > 0) {
    const appeared = rows.filter((row) => row.processing && !previous.rowIds.has(row.id) && !animatedIds.has(row.id) && !ids.includes(row.id));
    ids.push(...appeared.slice(-grownBy).map((row) => row.id));
  }
  return ids;
}

export interface ActivationState {
  snapshot: ActivationSnapshot | null;
  /** Rows that already animated; they never animate again. */
  animatedIds: ReadonlySet<string>;
  /** Rows currently playing the animation. */
  activeIds: ReadonlySet<string>;
}

export const initialActivationState: ActivationState = { snapshot: null, animatedIds: new Set(), activeIds: new Set() };

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Fold one render into the activation state; returns the same object when nothing changed. */
export function advanceActivation(
  state: ActivationState,
  sessionKey: string,
  rows: readonly ActivationRow[],
  queuedIds: ReadonlySet<string>,
): ActivationState {
  const sessionChanged = state.snapshot !== null && state.snapshot.sessionKey !== sessionKey;
  const base = sessionChanged ? initialActivationState : state;
  const planned = planActivationMotion(base.snapshot, sessionKey, rows, base.animatedIds);
  const rowIds = new Set(rows.map((row) => row.id));
  const processingCount = rows.filter((row) => row.processing).length;
  if (
    !sessionChanged && planned.length === 0 && state.snapshot
    && state.snapshot.processingCount === processingCount
    && sameSet(state.snapshot.queuedIds, queuedIds) && sameSet(state.snapshot.rowIds, rowIds)
  ) return state;
  return {
    snapshot: { sessionKey, queuedIds, rowIds, processingCount },
    animatedIds: planned.length ? new Set([...base.animatedIds, ...planned]) : base.animatedIds,
    activeIds: planned.length ? new Set([...base.activeIds, ...planned]) : base.activeIds,
  };
}

export function finishActivation(state: ActivationState, id: string): ActivationState {
  if (!state.activeIds.has(id)) return state;
  const activeIds = new Set(state.activeIds);
  activeIds.delete(id);
  return { ...state, activeIds };
}

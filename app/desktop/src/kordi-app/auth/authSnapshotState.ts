import type { DisplayAuthSnapshot } from './ompCatalog';

/** Keeps the auth page and the shared hosted-account store on the same snapshot list. */
export function createAuthSnapshotState(onChange: (snapshots: DisplayAuthSnapshot[]) => void) {
  let snapshots: DisplayAuthSnapshot[] = [];
  let generation = 0;

  return {
    current: () => snapshots,
    complete(snapshot: DisplayAuthSnapshot) {
      // An older load must not erase a login that finished while it was pending.
      generation += 1;
      snapshots = [...snapshots.filter((item) => item.snapshotId !== snapshot.snapshotId), snapshot];
      onChange(snapshots);
    },
    async refresh(load: () => Promise<DisplayAuthSnapshot[]>) {
      const request = ++generation;
      const loaded = await load();
      if (request !== generation) return;
      snapshots = loaded;
      onChange(snapshots);
    },
  };
}

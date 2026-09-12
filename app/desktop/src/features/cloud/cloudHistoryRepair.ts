// History coverage and canonical pruning scan durable message tables. Once a
// repair succeeds, an empty cursor poll cannot invalidate that result.
export function createCloudHistoryRepair() {
  let revision = 0;
  let repairedRevision = -1;
  let pending: Promise<void> | null = null;
  return {
    invalidate() { revision += 1; },
    run(repair: () => Promise<void>): Promise<void> | null {
      if (pending) return pending;
      if (repairedRevision === revision) return null;
      const startedRevision = revision;
      pending = Promise.resolve().then(repair).then(() => {
        repairedRevision = startedRevision;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}

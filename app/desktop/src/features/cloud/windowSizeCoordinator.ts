/** Serializes native mutations and coalesces requests to the latest surface. */
export function createWindowSizeCoordinator<T>(apply: (target: T) => Promise<void>) {
  let desired: T;
  let applied: T;
  let hasApplied = false;
  let pending: Promise<void> | undefined;

  return (target: T): Promise<void> => {
    desired = target;
    if (!pending && hasApplied && applied === target) return Promise.resolve();
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        do {
          const next = desired;
          hasApplied = false;
          try {
            await apply(next);
          } catch (error) {
            if (next !== desired) continue;
            throw error;
          }
          applied = next;
          hasApplied = true;
        } while (applied !== desired);
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
}

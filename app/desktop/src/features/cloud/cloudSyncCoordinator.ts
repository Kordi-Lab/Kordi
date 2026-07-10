type CloudSyncRun = (generation: number) => Promise<void>;

export class CloudSyncCoordinator {
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  private generation = 0;
  private latestRun: CloudSyncRun | null = null;

  changeAccount() {
    this.generation += 1;
    this.rerunRequested = false;
  }

  isCurrentGeneration(generation: number) {
    return generation === this.generation;
  }

  currentGeneration() {
    return this.generation;
  }

  request(runOnce: CloudSyncRun): Promise<void> {
    this.latestRun = runOnce;
    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }

    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drain() {
    let lastError: unknown = null;
    do {
      this.rerunRequested = false;
      const runOnce = this.latestRun;
      const generation = this.generation;
      if (!runOnce) return;
      try {
        await runOnce(generation);
        lastError = null;
      } catch (error) {
        lastError = error;
      }
    } while (this.rerunRequested);

    if (lastError) throw lastError;
  }
}

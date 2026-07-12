import type {
  AdoptCloudProfileIdentityRequest,
  CanonicalProfileIdentityDelta,
} from '@/kordi-app/types';

type CloudSyncRun = (generation: number) => Promise<void>;

type AdoptCloudProfileIdentity = (
  request: AdoptCloudProfileIdentityRequest,
) => Promise<CanonicalProfileIdentityDelta>;

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

  hasPendingWork() {
    return this.inFlight !== null;
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

export class CloudProfileIdentityAdoptionCoordinator {
  private readonly coordinator = new CloudSyncCoordinator();
  private pendingDeltas: CanonicalProfileIdentityDelta[] = [];

  changeAccount() {
    this.coordinator.changeAccount();
  }

  hasPendingWork() {
    return this.coordinator.hasPendingWork() || this.pendingDeltas.length > 0;
  }

  request(
    request: AdoptCloudProfileIdentityRequest,
    adopt: AdoptCloudProfileIdentity,
    commit: (delta: CanonicalProfileIdentityDelta) => void,
  ): Promise<void> {
    return this.coordinator.request(async (generation) => {
      try {
        this.pendingDeltas.push(await adopt(request));
      } finally {
        if (this.coordinator.isCurrentGeneration(generation)) {
          const pendingDeltas = this.pendingDeltas;
          this.pendingDeltas = [];
          pendingDeltas.forEach(commit);
        }
      }
    });
  }
}

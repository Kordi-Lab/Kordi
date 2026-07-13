export type CloudGroupReplayEntry<Row> = {
  key: string;
  row: Row;
};

export type CloudGroupReplayFailure = {
  key: string;
  attempt: number;
  retryDelayMs: number;
  error: unknown;
};

export type CloudGroupReplayRequest<Row> = {
  entries: readonly CloudGroupReplayEntry<Row>[];
  apply: (row: Row) => Promise<void>;
  onFailure?: (failure: CloudGroupReplayFailure) => void;
};

type RetryState = {
  attempt: number;
  nextEligibleAtMs: number;
};

type QueuedRequest<Row> = CloudGroupReplayRequest<Row> & {
  generation: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type CloudGroupReplayCoordinatorOptions = {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle | number;
  clearTimer?: (handle: TimerHandle | number) => void;
  baseRetryMs?: number;
  maxRetryMs?: number;
};

export class CloudGroupReplayCoordinator<Row> {
  private readonly now: () => number;
  private readonly setTimer: NonNullable<CloudGroupReplayCoordinatorOptions['setTimer']>;
  private readonly clearTimer: NonNullable<CloudGroupReplayCoordinatorOptions['clearTimer']>;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private accountKey: string | null = null;
  private generation = 0;
  private completedKeys = new Set<string>();
  private retryByKey = new Map<string, RetryState>();
  private pendingRequest: QueuedRequest<Row> | null = null;
  private latestRequest: CloudGroupReplayRequest<Row> | null = null;
  private drainPromise: Promise<void> | null = null;
  private retryTimer: TimerHandle | number | null = null;
  private retryTimerAtMs: number | null = null;

  constructor(options: CloudGroupReplayCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as TimerHandle));
    this.baseRetryMs = options.baseRetryMs ?? 1_000;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
  }

  changeAccount(accountKey: string | null) {
    if (this.accountKey === accountKey) return;
    this.accountKey = accountKey;
    this.generation += 1;
    this.completedKeys.clear();
    this.retryByKey.clear();
    this.pendingRequest = null;
    this.latestRequest = null;
    this.clearRetryTimer();
  }

  request(request: CloudGroupReplayRequest<Row>): Promise<void> {
    this.latestRequest = request;
    this.pendingRequest = { ...request, generation: this.generation };
    if (!this.drainPromise) this.startDrain();
    return this.drainPromise ?? Promise.resolve();
  }

  dispose() {
    this.accountKey = null;
    this.generation += 1;
    this.completedKeys.clear();
    this.retryByKey.clear();
    this.pendingRequest = null;
    this.latestRequest = null;
    this.clearRetryTimer();
  }

  private startDrain() {
    const running = this.drain().finally(() => {
      if (this.drainPromise === running) this.drainPromise = null;
      if (this.pendingRequest) this.startDrain();
      else this.scheduleRetry();
    });
    this.drainPromise = running;
  }

  private async drain() {
    while (this.pendingRequest) {
      const request = this.pendingRequest;
      this.pendingRequest = null;
      if (request.generation !== this.generation) continue;

      for (const entry of request.entries) {
        if (request.generation !== this.generation) break;
        if (this.completedKeys.has(entry.key)) continue;
        const retry = this.retryByKey.get(entry.key);
        if (retry && retry.nextEligibleAtMs > this.now()) continue;

        try {
          await request.apply(entry.row);
          if (request.generation !== this.generation) break;
          this.completedKeys.add(entry.key);
          this.retryByKey.delete(entry.key);
        } catch (error) {
          if (request.generation !== this.generation) break;
          const attempt = (retry?.attempt ?? 0) + 1;
          const retryDelayMs = Math.min(
            this.maxRetryMs,
            this.baseRetryMs * (2 ** Math.min(attempt - 1, 30)),
          );
          this.retryByKey.set(entry.key, {
            attempt,
            nextEligibleAtMs: this.now() + retryDelayMs,
          });
          request.onFailure?.({ key: entry.key, attempt, retryDelayMs, error });
        }
      }
    }
  }

  private scheduleRetry() {
    const request = this.latestRequest;
    if (!request) return;
    const requestKeys = new Set(request.entries.map((entry) => entry.key));
    const nextRetryAtMs = [...this.retryByKey.entries()]
      .filter(([key]) => requestKeys.has(key) && !this.completedKeys.has(key))
      .reduce<number | null>((earliest, [, retry]) => (
        earliest === null ? retry.nextEligibleAtMs : Math.min(earliest, retry.nextEligibleAtMs)
      ), null);
    if (nextRetryAtMs === null) {
      this.clearRetryTimer();
      return;
    }
    if (this.retryTimer !== null && this.retryTimerAtMs !== null && this.retryTimerAtMs <= nextRetryAtMs) return;
    this.clearRetryTimer();
    this.retryTimerAtMs = nextRetryAtMs;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.retryTimerAtMs = null;
      const latest = this.latestRequest;
      if (latest) void this.request(latest);
    }, Math.max(0, nextRetryAtMs - this.now()));
  }

  private clearRetryTimer() {
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.retryTimerAtMs = null;
  }
}


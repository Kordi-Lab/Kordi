export type CloudAgentTurnAdmission = {
  accepted: boolean;
  queued: boolean;
};

type CloudAgentTurnJob = {
  runtimeSessionId: string;
  requestId: string;
  run(signal: AbortSignal): Promise<void>;
  onError?(
    error: unknown,
    signal: AbortSignal,
  ): void | Promise<void>;
};

/**
 * Owns Cloud-agent execution admission for the active account.
 *
 * Jobs sharing one runtime session run in FIFO order. Different runtime
 * sessions remain independent, and the original request id is the
 * idempotency key for the lifetime of the active account context.
 */
export class CloudAgentTurnCoordinator {
  private accountKey: string | null;
  private generation = 0;
  private abortController = new AbortController();
  private readonly admittedRequestKeys = new Set<string>();
  private readonly tailsByRuntimeSessionId = new Map<string, Promise<void>>();

  constructor(accountKey: string | null = null) {
    this.accountKey = accountKey;
  }

  changeAccount(accountKey: string | null): void {
    if (this.accountKey === accountKey) return;
    this.accountKey = accountKey;
    this.resetContext();
  }

  activeContextSignal(): AbortSignal {
    return this.abortController.signal;
  }

  enqueue(job: CloudAgentTurnJob): CloudAgentTurnAdmission {
    const runtimeSessionId = job.runtimeSessionId.trim();
    const requestId = job.requestId.trim();
    if (!runtimeSessionId || !requestId) {
      return { accepted: false, queued: false };
    }

    const requestKey = `${this.generation}:${runtimeSessionId}:${requestId}`;
    if (this.admittedRequestKeys.has(requestKey)) {
      return { accepted: false, queued: false };
    }
    this.admittedRequestKeys.add(requestKey);

    const previous = this.tailsByRuntimeSessionId.get(runtimeSessionId);
    const generation = this.generation;
    const signal = this.abortController.signal;
    const execute = async () => {
      if (generation !== this.generation || signal.aborted) return;
      try {
        await job.run(signal);
      } catch (error) {
        if (generation === this.generation && !signal.aborted) {
          await job.onError?.(error, signal);
        }
      }
    };
    const running = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(execute);
    const settled = running
      .catch(() => undefined)
      .finally(() => {
        if (this.tailsByRuntimeSessionId.get(runtimeSessionId) === settled) {
          this.tailsByRuntimeSessionId.delete(runtimeSessionId);
        }
      });
    this.tailsByRuntimeSessionId.set(runtimeSessionId, settled);

    return { accepted: true, queued: Boolean(previous) };
  }

  async waitForIdle(runtimeSessionId?: string): Promise<void> {
    const target = runtimeSessionId?.trim();
    while (true) {
      const pending = target
        ? [this.tailsByRuntimeSessionId.get(target)].filter(
          (value): value is Promise<void> => Boolean(value),
        )
        : [...this.tailsByRuntimeSessionId.values()];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  dispose(): void {
    this.accountKey = null;
    this.resetContext();
  }

  private resetContext(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.generation += 1;
    this.admittedRequestKeys.clear();
    this.tailsByRuntimeSessionId.clear();
  }
}

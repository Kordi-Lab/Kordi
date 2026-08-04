import type { ChatPerformanceResultClass } from '@/features/performance/chatPerformance';
import type { CloudMessage } from './authClient';
import type { CloudGroupAgentRuntime } from './cloudGroupControlContext';

export const CLOUD_GROUP_AGENT_GUARD_TIMEOUT_MS = 5_000;

export type CloudGroupAgentGuardDecision = {
  requestAlreadyOwned: boolean;
  resultClass: Extract<
    ChatPerformanceResultClass,
    'success' | 'failed' | 'timeout' | 'owned-elsewhere'
  >;
};

export async function cloudGroupAgentGuardDecision<T>({
  loadMessages,
  fallbackOwnsRequest,
  responseExists,
  timeoutMs = CLOUD_GROUP_AGENT_GUARD_TIMEOUT_MS,
}: {
  loadMessages: () => Promise<readonly T[]>;
  fallbackOwnsRequest: () => Promise<boolean>;
  responseExists: (messages: readonly T[]) => boolean;
  timeoutMs?: number;
}): Promise<CloudGroupAgentGuardDecision> {
  const [messages, fallbackOwns] = await Promise.all([
    settleWithin(loadMessages(), timeoutMs, [] as readonly T[]),
    settleWithin(fallbackOwnsRequest(), timeoutMs, false),
  ]);
  const requestAlreadyOwned = fallbackOwns.value
    || responseExists(messages.value);
  const guardFailed = messages.result === 'failed'
    || fallbackOwns.result === 'failed';
  const guardTimedOut = messages.result === 'timeout'
    || fallbackOwns.result === 'timeout';
  return {
    requestAlreadyOwned,
    resultClass: requestAlreadyOwned
      ? 'owned-elsewhere'
      : guardTimedOut
        ? 'timeout'
        : guardFailed
          ? 'failed'
          : 'success',
  };
}

export async function loadCloudGroupAgentTargetMessages(
  runtime: CloudGroupAgentRuntime,
  token: string,
  targetAccountIds: string[],
): Promise<CloudMessage[]> {
  return (await Promise.all(
    targetAccountIds.map((targetAccountId) => runtime.client
      .listMessageSnapshot(token, targetAccountId, 100)
      .then((snapshot) => snapshot.messages)
      .catch(() => [])),
  )).flat();
}

type SettledWithin<T> = {
  value: T;
  result: 'success' | 'failed' | 'timeout';
};

function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<SettledWithin<T>> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result: SettledWithin<T>) => {
      if (finished) return;
      finished = true;
      globalThis.clearTimeout(timer);
      resolve(result);
    };
    const timer = globalThis.setTimeout(
      () => finish({ value: fallback, result: 'timeout' }),
      Math.max(0, timeoutMs),
    );
    void promise.then(
      (value) => finish({ value, result: 'success' }),
      () => finish({ value: fallback, result: 'failed' }),
    );
  });
}

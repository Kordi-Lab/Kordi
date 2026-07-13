export type ChatScaleBenchmarkMetrics = {
  bridgeMapMs: number;
  canonicalIndexMs: number;
  cloudIndexMs: number;
  cloudIndexDeltaMs: number;
  cloudDeliveryLookupMs: number;
  serializedCacheBytes: number;
};

export type ChatScaleBenchmarkBudgets = ChatScaleBenchmarkMetrics;

// These ceilings protect the linear/indexed contracts without assuming an idle
// workstation. The quiet-host medians remain documented in the evidence report;
// the extra headroom prevents normal renderer/system contention from making the
// deterministic fixture gate flaky.
export const CHAT_SCALE_BENCHMARK_BUDGETS: ChatScaleBenchmarkBudgets = {
  bridgeMapMs: 100,
  canonicalIndexMs: 160,
  cloudIndexMs: 4_000,
  cloudIndexDeltaMs: 80,
  cloudDeliveryLookupMs: 5,
  serializedCacheBytes: 70 * 1024 * 1024,
};

export function chatScaleBenchmarkBudgetFailures(
  metrics: ChatScaleBenchmarkMetrics,
): string[] {
  const failures: string[] = [];
  for (const [metric, limit] of Object.entries(CHAT_SCALE_BENCHMARK_BUDGETS) as Array<[
    keyof ChatScaleBenchmarkBudgets,
    number,
  ]>) {
    if (metrics[metric] > limit) {
      failures.push(`${metric}=${metrics[metric]} exceeds ${limit}`);
    }
  }
  return failures;
}

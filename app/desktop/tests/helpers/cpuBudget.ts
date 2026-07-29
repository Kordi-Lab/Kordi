export function measureCpuMs<T>(operation: () => T) {
  const startedAt = process.cpuUsage();
  const result = operation();
  const elapsed = process.cpuUsage(startedAt);
  return {
    result,
    cpuMs: (elapsed.user + elapsed.system) / 1_000,
  };
}

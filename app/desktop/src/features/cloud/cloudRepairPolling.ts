export const CLOUD_MESSAGES_REFRESH_MS = 15_000;
export const CLOUD_BACKGROUND_MESSAGES_REFRESH_MS = 60_000;

// Realtime still delivers background messages immediately. Only redundant
// repair requests slow down; a disconnected socket retains the normal poll.
export function createCloudRepairPolling(now = () => Date.now()) {
  let realtimeConnected = false;
  let lastPollAt = now();
  let pending = false;
  return {
    setRealtimeConnected(connected: boolean) {
      if (realtimeConnected && !connected) lastPollAt = Number.NEGATIVE_INFINITY;
      realtimeConnected = connected;
    },
    async poll(hidden: boolean, sync: () => Promise<void>) {
      const interval = hidden && realtimeConnected
        ? CLOUD_BACKGROUND_MESSAGES_REFRESH_MS
        : CLOUD_MESSAGES_REFRESH_MS;
      if (pending || now() - lastPollAt < interval) return;
      lastPollAt = now();
      pending = true;
      try {
        await sync();
      } catch {
        // Retry at the next normal tick even if the socket still looks open.
        lastPollAt = Number.NEGATIVE_INFINITY;
      } finally {
        pending = false;
      }
    },
  };
}

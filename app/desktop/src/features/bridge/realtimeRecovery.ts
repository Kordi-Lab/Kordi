export const BRIDGE_REALTIME_RECOVERY_THROTTLE_MS = 5000;

export function shouldRefreshBridgeRealtimeForVisibility(visibilityState: DocumentVisibilityState) {
  return visibilityState === 'visible';
}

export function shouldRunBridgeRealtimeRecovery(
  nowMs: number,
  lastRefreshAtMs: number,
  throttleMs = BRIDGE_REALTIME_RECOVERY_THROTTLE_MS,
) {
  return lastRefreshAtMs <= 0 || nowMs - lastRefreshAtMs >= throttleMs;
}

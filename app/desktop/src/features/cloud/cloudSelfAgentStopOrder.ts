/** Request ids with a live local turn on this Mac. */
export type LocalTurnRequestIds = { has(requestId: string): boolean };

/**
 * The request this Mac executes that a stop in `sessionId` ends: the one with
 * a live local turn, else the newest started.
 */
export function cloudSelfAgentLocalRequestToStop<T extends { sessionId: string }>(
  activeRequests: ReadonlyMap<string, T>,
  sessionId: string,
  localTurnRequestIds: LocalTurnRequestIds,
): T | null {
  let newest: T | null = null;
  let withLocalTurn: T | null = null;
  for (const [requestId, active] of activeRequests) {
    if (active.sessionId !== sessionId) continue;
    newest = active;
    if (localTurnRequestIds.has(requestId)) withLocalTurn = active;
  }
  return withLocalTurn ?? newest;
}

/**
 * Unfinished requests in the order a stop tries them: one with a live local
 * turn first, then newest to oldest, so a stale unanswered request is tried last.
 */
export function cloudSelfAgentStopOrder<T extends { messageId: string; createdAt: string }>(
  pending: readonly T[],
  localTurnRequestIds: LocalTurnRequestIds,
): T[] {
  const atMs = (request: T) => Date.parse(request.createdAt) || 0;
  return [...pending].sort((left, right) => (
    Number(localTurnRequestIds.has(right.messageId)) - Number(localTurnRequestIds.has(left.messageId))
    || atMs(right) - atMs(left)
  ));
}

/**
 * Runtime sessions whose native turn runs an Ask Agent request under its
 * cloud execution lease. The request's reply row shows that turn's progress
 * and its stop control, so the desktop live-turn store must not show the
 * same turn a second time. A second copy would keep its own running state
 * after the request has its terminal reply.
 */
const holdsBySessionId = new Map<string, number>();

/** Marks `sessionId` as running a leased turn until the returned release is called. */
export function holdLeasedTurnSession(sessionId: string): () => void {
  const id = sessionId.trim();
  if (!id) return () => undefined;
  holdsBySessionId.set(id, (holdsBySessionId.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (holdsBySessionId.get(id) ?? 1) - 1;
    if (remaining > 0) holdsBySessionId.set(id, remaining);
    else holdsBySessionId.delete(id);
  };
}

export function sessionRunsLeasedTurn(sessionId: string | null | undefined): boolean {
  const id = sessionId?.trim();
  return Boolean(id && holdsBySessionId.has(id));
}

import type { CanonicalSessionState } from '@/kordi-app/types';

/** A hosted request with no reply activity for this long no longer holds its session's queue. */
export const HOSTED_REQUEST_IDLE_RELEASE_MS = 120_000;

/** When this Mac last saw a hosted request or its reply change. */
export type HostedRequestActivity = { key: string; lastActivityMs: number };

function requestIdOf(content: unknown) {
  return content && typeof content === 'object' && !Array.isArray(content)
    ? (content as Record<string, unknown>).requestId
    : undefined;
}

/** A fingerprint of the request row and its replies; it changes whenever the run makes progress. */
export function hostedRequestActivityKey(
  state: CanonicalSessionState | null | undefined,
  requestMessageId: string,
) {
  return (state?.messages ?? [])
    .filter((message) => (
      message.id === requestMessageId
      || message.parentMessageId === requestMessageId
      || requestIdOf(message.content) === requestMessageId
    ))
    .map((message) => `${message.id}:${message.status}:${message.updatedAtMs}:${message.contentText?.length ?? 0}`)
    .join('|');
}

/** Keeps the previous activity while nothing changed, so the idle deadline keeps running. */
export function nextHostedRequestActivity(
  previous: HostedRequestActivity | undefined,
  key: string,
  nowMs: number,
): HostedRequestActivity {
  return previous && previous.key === key ? previous : { key, lastActivityMs: nowMs };
}

export function hostedRequestWaitIsIdle(activity: HostedRequestActivity, nowMs: number) {
  return nowMs - activity.lastActivityMs >= HOSTED_REQUEST_IDLE_RELEASE_MS;
}

const releaseListeners = new Set<(sessionId: string) => void>();

export function subscribeHostedRequestWaitRelease(listener: (sessionId: string) => void) {
  releaseListeners.add(listener);
  return () => { releaseListeners.delete(listener); };
}

/** Stops a session's queue waiting on its hosted request, e.g. after a stop found nothing to stop. */
export function releaseHostedRequestWait(sessionId: string | null | undefined) {
  const id = sessionId?.trim();
  if (!id) return;
  for (const listener of [...releaseListeners]) listener(id);
}

/** The hosted request waits of one chat surface, with each wait's progress and idle timer. */
export type HostedRequestWaitTracker = {
  /** Session id to the request message id its queue waits on. */
  waits: () => Map<string, string>;
  state: () => CanonicalSessionState | null | undefined;
  isSettled: (state: CanonicalSessionState | null | undefined, requestMessageId: string) => boolean;
  onRelease: (sessionId: string) => void;
  activity: Map<string, HostedRequestActivity>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
};

export function releaseTrackedHostedRequestWait(tracker: HostedRequestWaitTracker, sessionId: string) {
  clearTimeout(tracker.timers.get(sessionId));
  tracker.timers.delete(sessionId);
  tracker.activity.delete(sessionId);
  if (tracker.waits().delete(sessionId)) tracker.onRelease(sessionId);
}

/** Releases the wait once the request settles or shows no progress for the idle limit; otherwise rearms its timer. */
export function reviewHostedRequestWait(tracker: HostedRequestWaitTracker, sessionId: string, nowMs = Date.now()) {
  const requestMessageId = tracker.waits().get(sessionId);
  if (!requestMessageId) return;
  const state = tracker.state();
  const activity = nextHostedRequestActivity(tracker.activity.get(sessionId), hostedRequestActivityKey(state, requestMessageId), nowMs);
  if (tracker.isSettled(state, requestMessageId) || hostedRequestWaitIsIdle(activity, nowMs)) {
    releaseTrackedHostedRequestWait(tracker, sessionId);
    return;
  }
  tracker.activity.set(sessionId, activity);
  clearTimeout(tracker.timers.get(sessionId));
  tracker.timers.set(sessionId, setTimeout(
    () => reviewHostedRequestWait(tracker, sessionId),
    activity.lastActivityMs + HOSTED_REQUEST_IDLE_RELEASE_MS - nowMs,
  ));
}

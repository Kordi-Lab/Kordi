import type { CloudAuthClient } from './authClient';
import type { CloudAgentReplyEnding } from './cloudAgentMessages';
import { loadSession } from './session';

export type InterruptedCloudAgentRequest = {
  sessionId: string;
  requestId: string;
};

export type InterruptedCloudAgentReleaseResult = {
  released: number;
  failures: unknown[];
};

/**
 * Tells the server that this desktop lost the turns it was running for these
 * requests, for example after an app reload. The execution lease lives in
 * memory, so only the server can end the run and publish the terminal reply
 * that moves other devices out of the processing state.
 */
export async function releaseInterruptedCloudAgentRequests(
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>,
  requests: readonly InterruptedCloudAgentRequest[],
  loadToken: () => Promise<string | null | undefined> = async () =>
    (await loadSession())?.token,
): Promise<InterruptedCloudAgentReleaseResult> {
  const unique = new Map<string, InterruptedCloudAgentRequest>();
  for (const request of requests) {
    const sessionId = request.sessionId.trim();
    const requestId = request.requestId.trim();
    if (sessionId && requestId) {
      unique.set(`${sessionId}\n${requestId}`, { sessionId, requestId });
    }
  }
  if (unique.size === 0) return { released: 0, failures: [] };
  const token = await loadToken();
  if (!token) return { released: 0, failures: [] };
  const results = await Promise.allSettled([...unique.values()].map(
    ({ sessionId, requestId }) => client.desktopAgentExecution<{ released?: boolean }>(
      token,
      'interrupted',
      { sessionId, requestMessageId: requestId },
    ),
  ));
  return {
    released: results.filter(
      (result) => result.status === 'fulfilled' && result.value?.released === true,
    ).length,
    failures: results.flatMap((result): unknown[] => (
      result.status === 'rejected' ? [result.reason as unknown] : []
    )),
  };
}

export type CloudAgentRunClosure = {
  sessionId: string;
  requestId: string;
  /** How the run ended. The server never reopens an ended run. */
  state: 'completed' | 'failed' | 'cancelled';
  /** The terminal reply the server publishes when the request has none yet. */
  text?: string;
  ending?: CloudAgentReplyEnding;
};

export type CloudAgentRunClosureResult = {
  /** A run of this device exists for the request. */
  released: boolean;
  /** This call ended a run that was still open. */
  closed: boolean;
  /** This call published the terminal reply. */
  published: boolean;
};

/**
 * Ends this device's run for a request in the same step as its terminal
 * reply. It needs no execution lease, so it also works after the lease was
 * lost: the server publishes the reply when no terminal reply exists yet.
 */
export async function closeCloudAgentRunFromDesktop(
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>,
  token: string,
  closure: CloudAgentRunClosure,
): Promise<CloudAgentRunClosureResult> {
  const response = await client.desktopAgentExecution<Partial<CloudAgentRunClosureResult> | null>(
    token,
    'interrupted',
    {
      sessionId: closure.sessionId,
      requestMessageId: closure.requestId,
      state: closure.state,
      ...(closure.text?.trim() ? { text: closure.text } : {}),
      ...(closure.ending ? { ending: closure.ending } : {}),
    },
  );
  return {
    released: response?.released === true,
    closed: response?.closed === true,
    published: response?.published === true,
  };
}

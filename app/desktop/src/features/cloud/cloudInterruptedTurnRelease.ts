import type { CloudAuthClient } from './authClient';
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

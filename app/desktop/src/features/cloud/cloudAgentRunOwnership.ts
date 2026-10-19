import type { CloudAgentRun, CloudAuthClient } from './authClient';
import { cloudAgentRunAlreadyOwnsRequest } from './cloudAgentRequestState';

/**
 * Whether a runtime is already executing the request. A `queued` run is
 * waiting for the owner's Mac first and the cloud runner after that, so the
 * owner's Mac still claims it; only a leased, running, or completed run
 * keeps the Mac from starting the request.
 */
export function cloudAgentRunExecutingRequest(
  run: CloudAgentRun | null | undefined,
): boolean {
  const status = run?.status;
  return status === 'leased' || status === 'running' || status === 'completed';
}

/** Run lookup before the owner's Mac claims a request. */
export async function cloudFallbackRunExecutingRequest({
  client,
  token,
  requestMessageId,
}: {
  client: CloudAuthClient;
  token: string;
  requestMessageId: string;
}): Promise<boolean> {
  const run = await client
    .lookupCloudAgentRunForRequest(token, requestMessageId)
    .catch(() => null);
  return cloudAgentRunExecutingRequest(run);
}

/**
 * Run lookup before the requester shows that no agent replied. A lookup that
 * fails is `unknown`: the request may still be running, so the notice waits
 * for a lookup that answers.
 */
export async function cloudFallbackRunOwnership({
  client,
  token,
  requestMessageId,
}: {
  client: CloudAuthClient;
  token: string;
  requestMessageId: string;
}): Promise<'owned' | 'not-owned' | 'unknown'> {
  try {
    const run = await client.lookupCloudAgentRunForRequest(token, requestMessageId);
    return cloudAgentRunAlreadyOwnsRequest(run) ? 'owned' : 'not-owned';
  } catch {
    return 'unknown';
  }
}

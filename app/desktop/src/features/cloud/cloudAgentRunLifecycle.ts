import type { CloudAuthClient } from './authClient';
import type { CloudAgentRun } from './cloudAgentRunTypes';

export function cloudAgentRunStatusAlreadyOwnsRequest(
  status: string | null | undefined,
): boolean {
  return status === 'queued'
    || status === 'leased'
    || status === 'running'
    || status === 'completed'
    || status === 'cancelled';
}

export type CloudAgentRunLifecycleState =
  | 'processing'
  | 'complete'
  | 'failed'
  | 'cancelled';

export function cloudAgentRunLifecycleState(
  status: string | null | undefined,
): CloudAgentRunLifecycleState | null {
  if (status === 'queued' || status === 'leased' || status === 'running') {
    return 'processing';
  }
  if (status === 'completed') return 'complete';
  if (status === 'failed' || status === 'cancelled') return status;
  return null;
}

export function cloudAgentRunAlreadyOwnsRequest(
  run: CloudAgentRun | null | undefined,
): boolean {
  return cloudAgentRunStatusAlreadyOwnsRequest(run?.status);
}

export async function cloudFallbackRunAlreadyOwnsRequest({
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
  return cloudAgentRunAlreadyOwnsRequest(run);
}

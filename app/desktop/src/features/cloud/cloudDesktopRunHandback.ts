import type { CloudAuthClient } from './authClient';
import { CloudAuthError } from './cloudAuthError';

/** The part of a desktop execution lease a hand-back needs. */
export type HandBackLease = {
  runId: string;
  claimId: string;
  dispose: () => void;
};

const HAND_BACK_ATTEMPTS = 3;
const HAND_BACK_RETRY_MS = 1_000;

/**
 * Hands a run this Mac claimed but could not start back to the cloud runner,
 * which then answers it at once instead of the request failing. Returns
 * `false` when the run stays with this Mac, for example a project session the
 * cloud cannot run; the caller then ends it with its failure reply.
 */
export async function handBackDesktopRun(
  client: Pick<CloudAuthClient, 'desktopAgentExecution'>,
  token: string,
  lease: HandBackLease,
  { retryMs = HAND_BACK_RETRY_MS }: { retryMs?: number } = {},
): Promise<boolean> {
  // Stop renewing first: the run is no longer this Mac's to keep.
  lease.dispose();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await client.desktopAgentExecution<{ released?: boolean } | null>(
        token,
        `${encodeURIComponent(lease.runId)}/release`,
        { claimId: lease.claimId },
      );
      return response?.released === true;
    } catch (error) {
      // A refusal is final; a slow or failed request is retried.
      if (error instanceof CloudAuthError && error.status < 500) return false;
      if (attempt >= HAND_BACK_ATTEMPTS) return false;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

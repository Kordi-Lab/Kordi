// The calls agent trust views make, behind one small seam so views and tests
// can supply their own. Production uses the signed-in session and the cloud
// chat client.
import type { AgentTrustClient } from '@/features/cloud/agentTrustClient';
import { CloudAuthClient } from '@/features/cloud/authClient';
import { CloudAuthError } from '@/features/cloud/cloudAuthError';
import { loadSession } from '@/features/cloud/session';

export type AgentTrustCalls = Pick<
  AgentTrustClient,
  'aiFeatures' | 'aiAccess' | 'updateAiAccess' | 'listAgentActions' | 'decideAgentAction' | 'replyDisclosures'
>;

export type AgentTrustApi = {
  session(): Promise<{ token: string; accountId: string } | null>;
  calls: AgentTrustCalls;
};

let defaultApi: AgentTrustApi | null = null;

export function defaultAgentTrustApi(): AgentTrustApi {
  defaultApi ??= {
    session: async () => {
      const session = await loadSession();
      return session?.token ? { token: session.token, accountId: session.accountId } : null;
    },
    calls: new CloudAuthClient().chat.agentTrust,
  };
  return defaultApi;
}

/** The server error code of a failed call, when it sent one. */
export function agentTrustErrorCode(error: unknown): string | null {
  return error instanceof CloudAuthError && error.code !== 'unknown' ? error.code : null;
}

export function agentTrustErrorStatus(error: unknown): number | null {
  return error instanceof CloudAuthError ? error.status : null;
}

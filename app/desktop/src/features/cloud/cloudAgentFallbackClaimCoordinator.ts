import type {
  CloudAgentRunClaimInput,
  CloudAuthClient,
} from './authClient';
import {
  cloudFallbackClaimErrorIsRetryable,
  cloudFallbackClaimFailureDiagnostic,
} from './cloudFallbackClaimDiagnostics';
import type {
  CloudFallbackClaimAttemptResult,
} from './cloudAgentRequestState';
import { cloudAgentRunLifecycleState } from './cloudAgentRunLifecycle';
import { loadSession } from './session';

export class CloudAgentFallbackClaimCoordinator {
  private readonly claimedStates = new Map<string, 'active' | 'terminal'>();
  private readonly claimingKeys = new Set<string>();

  reset(): void {
    this.claimedStates.clear();
    this.claimingKeys.clear();
  }

  hasClaim(idempotencyKey: string): boolean {
    return this.claimedStates.has(idempotencyKey);
  }

  forget(idempotencyKey: string): void {
    this.claimedStates.delete(idempotencyKey);
  }

  async claim({
    client,
    claim,
    tokenOverride,
    reportWarning,
  }: {
    client: CloudAuthClient;
    claim: CloudAgentRunClaimInput;
    tokenOverride?: string | null;
    reportWarning: (message: string, error: unknown) => void;
  }): Promise<CloudFallbackClaimAttemptResult> {
    const existing = this.claimedStates.get(claim.idempotencyKey);
    if (existing) return existing === 'terminal' ? 'terminal' : 'already-claimed';
    if (this.claimingKeys.has(claim.idempotencyKey)) return 'in-flight';
    const token = tokenOverride?.trim() || (await loadSession())?.token?.trim();
    if (!token) return 'not-signed-in';
    this.claimingKeys.add(claim.idempotencyKey);
    try {
      const run = await client.claimCloudAgentRun(token, claim);
      const lifecycle = cloudAgentRunLifecycleState(run.status);
      if (!lifecycle) return 'terminal-failure';
      const terminal = lifecycle !== 'processing';
      this.claimedStates.set(
        claim.idempotencyKey,
        terminal ? 'terminal' : 'active',
      );
      return terminal ? 'terminal' : 'claimed';
    } catch (error) {
      reportWarning(
        '[cloud-agent-fallback] claim failed',
        cloudFallbackClaimFailureDiagnostic(error),
      );
      return cloudFallbackClaimErrorIsRetryable(error)
        ? 'retryable-failure'
        : 'terminal-failure';
    } finally {
      this.claimingKeys.delete(claim.idempotencyKey);
    }
  }
}

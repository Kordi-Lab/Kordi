import {
  CLOUD_AGENT_MODEL_UNAVAILABLE_NOTICE,
  CLOUD_AGENT_NO_PROVIDER_NOTICE,
  CLOUD_AGENT_SIGN_IN_AGAIN_NOTICE,
  isCloudAgentModelUnavailableError,
  isCloudAgentNoProviderConfiguredError,
  isCloudAgentSignInAgainError,
} from './cloudAgentMessages';

/** Shown to the agent's owner when their Mac could not load the account the agent runs on. */
export const CLOUD_AGENT_RECONNECT_ACCOUNT_NOTICE = 'Reconnect your account to run your agent.';

function normalizedErrorText(value: unknown): string {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return message.trim().toLowerCase();
}

/**
 * The owner's Mac could not load the hosted account for a claimed run, so the
 * turn ended before the model was called.
 */
export function isCloudAgentHostedCredentialUnavailableError(value: unknown): boolean {
  const normalized = normalizedErrorText(value);
  return normalized.includes('hosted provider credentials are unavailable')
    || normalized.includes('hosted provider requests require an active desktop execution lease')
    || normalized.includes('hosted provider route is unavailable')
    || normalized === CLOUD_AGENT_RECONNECT_ACCOUNT_NOTICE.toLowerCase();
}

/** The short notice for an account or model failure, or null for any other error. */
export function cloudAgentProviderFailureNotice(value: unknown): string | null {
  if (isCloudAgentSignInAgainError(value)) return CLOUD_AGENT_SIGN_IN_AGAIN_NOTICE;
  if (isCloudAgentHostedCredentialUnavailableError(value)) return CLOUD_AGENT_RECONNECT_ACCOUNT_NOTICE;
  if (isCloudAgentModelUnavailableError(value)) return CLOUD_AGENT_MODEL_UNAVAILABLE_NOTICE;
  return isCloudAgentNoProviderConfiguredError(value) ? CLOUD_AGENT_NO_PROVIDER_NOTICE : null;
}

/** Failures the Authentication page can fix: a missing account or an expired sign-in. */
export function cloudAgentProviderFailureNeedsAuthentication(value: unknown): boolean {
  return isCloudAgentSignInAgainError(value)
    || isCloudAgentHostedCredentialUnavailableError(value)
    || isCloudAgentNoProviderConfiguredError(value);
}

/** The neutral reply other members see when the agent could not answer. */
export function cloudAgentCouldNotAnswerText(agentName: string | null | undefined): string {
  const name = agentName?.trim();
  return name ? `${name} couldn't answer.` : "The agent couldn't answer.";
}

/**
 * The failure line a shared reply row carries, which every member reads. A
 * missing hosted account reads as a neutral line there; only the owner's own
 * turn shows how to reconnect it. Null for an error with no short notice.
 */
export function cloudAgentSharedReplyFailureNotice(
  value: unknown,
  agentName: string | null | undefined,
): string | null {
  return isCloudAgentHostedCredentialUnavailableError(value)
    ? cloudAgentCouldNotAnswerText(agentName)
    : cloudAgentProviderFailureNotice(value);
}

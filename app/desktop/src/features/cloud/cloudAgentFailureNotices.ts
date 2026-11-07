import {
  CLOUD_AGENT_MODEL_UNAVAILABLE_NOTICE,
  CLOUD_AGENT_NO_PROVIDER_NOTICE,
  isCloudAgentModelUnavailableError,
  isCloudAgentNoProviderConfiguredError,
  isCloudAgentProviderExpiredError,
} from './cloudAgentMessages';
import { cloudAgentFailureCodeValue, type CloudAgentFailureCode } from './cloudAgentFailureCode';

export { cloudAgentFailureCodeValue, type CloudAgentFailureCode } from './cloudAgentFailureCode';

/** Older builds showed this line when the owner's Mac could not load the provider account. */
const LEGACY_RECONNECT_ACCOUNT_NOTICE = 'reconnect your account to run your agent.';
const UNNAMED_PROVIDER = 'AI provider';

function errorText(value: unknown): string {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return message.trim();
}

/**
 * The owner's Mac could not load the hosted account for a claimed run, so the
 * turn ended before the model was called.
 */
export function isCloudAgentHostedCredentialUnavailableError(value: unknown): boolean {
  const normalized = errorText(value).toLowerCase();
  return normalized.includes('hosted provider credentials are unavailable')
    || normalized.includes('hosted provider requests require an active desktop execution lease')
    || normalized.includes('hosted provider route is unavailable')
    || normalized === LEGACY_RECONNECT_ACCOUNT_NOTICE
    || /^your .{1,60} connection is unavailable\.$/.test(normalized);
}

/** The provider an expired or unavailable connection belongs to, when the error names it. */
export function cloudAgentFailureProviderName(value: unknown): string | null {
  const text = errorText(value);
  const match = /^(.{1,40}?) OAuth credentials are not usable/i.exec(text)
    ?? /^Your (.{1,60}?) connection (?:expired|is unavailable)\.$/i.exec(text);
  const name = match?.[1]?.trim() ?? '';
  return name && name.toLowerCase() !== UNNAMED_PROVIDER.toLowerCase() ? name : null;
}

/** The failure category of a raw error or a stored failure line. */
export function cloudAgentFailureCodeForError(value: unknown): CloudAgentFailureCode {
  if (isCloudAgentProviderExpiredError(value)) return 'provider_auth_rejected';
  if (isCloudAgentHostedCredentialUnavailableError(value)) return 'hosted_credentials_unavailable';
  if (isCloudAgentModelUnavailableError(value)) return 'model_unavailable';
  return isCloudAgentNoProviderConfiguredError(value) ? 'missing_provider_auth' : 'failed';
}

/** The owner's line for a failure category, or null when the category has no short line. */
export function cloudAgentOwnerFailureNotice(code: CloudAgentFailureCode, provider?: string | null): string | null {
  const providerName = provider?.trim() || UNNAMED_PROVIDER;
  switch (code) {
    case 'provider_auth_rejected': return `Your ${providerName} connection expired.`;
    case 'hosted_credentials_unavailable': return `Your ${providerName} connection is unavailable.`;
    case 'model_unavailable': return CLOUD_AGENT_MODEL_UNAVAILABLE_NOTICE;
    case 'missing_provider_auth': return CLOUD_AGENT_NO_PROVIDER_NOTICE;
    case 'model_provider_error': return 'The provider failed while Kordi was replying. Try again in a moment.';
    case 'sandbox_error': return "Kordi Cloud couldn't finish this reply in the sandbox. Try again.";
    default: return null;
  }
}

/** The short notice for an account or model failure, or null for any other error. */
export function cloudAgentProviderFailureNotice(value: unknown): string | null {
  const code = cloudAgentFailureCodeForError(value);
  return code === 'failed' ? null : cloudAgentOwnerFailureNotice(code, cloudAgentFailureProviderName(value));
}

/**
 * The link a failure line offers the agent's owner. Both open the provider
 * settings under Authentication; neither means signing in to Kordi.
 */
export function cloudAgentProviderFailureActionLabel(value: unknown): 'Reconnect' | 'Connect' | null {
  switch (cloudAgentFailureCodeForError(value)) {
    case 'provider_auth_rejected':
    case 'hosted_credentials_unavailable':
      return 'Reconnect';
    case 'missing_provider_auth':
      return 'Connect';
    default:
      return null;
  }
}

/** Failures the Authentication page can fix: a missing or expired provider connection. */
export function cloudAgentProviderFailureNeedsAuthentication(value: unknown): boolean {
  return cloudAgentProviderFailureActionLabel(value) !== null;
}

/** The neutral line other members see when the agent could not reply. */
export function cloudAgentCouldNotReplyText(agentName: string | null | undefined): string {
  const name = agentName?.trim();
  return name ? `${name} couldn't reply.` : "The agent couldn't reply.";
}

/**
 * What a failed reply shares with every member: a neutral line and the
 * failure category. The owner's devices render the reason from the code.
 */
export function cloudAgentSharedFailure(
  value: unknown,
  agentName: string | null | undefined,
): { text: string; failureCode: CloudAgentFailureCode } {
  return { text: cloudAgentCouldNotReplyText(agentName), failureCode: cloudAgentFailureCodeForError(value) };
}

/**
 * The failure line one viewer sees. Other members read only that the agent
 * could not reply. The owner reads the reason from the stored code, or the
 * stored line for a reply an older build saved without one.
 */
export function cloudAgentViewerFailureText(input: {
  error: string | null | undefined;
  failureCode?: unknown;
  viewerOwnsAgent: boolean;
  agentName: string | null | undefined;
}): string {
  if (!input.viewerOwnsAgent) return cloudAgentCouldNotReplyText(input.agentName);
  const code = cloudAgentFailureCodeValue(input.failureCode);
  const notice = code ? cloudAgentOwnerFailureNotice(code, cloudAgentFailureProviderName(input.error)) : null;
  return notice ?? (input.error?.trim() || cloudAgentCouldNotReplyText(input.agentName));
}

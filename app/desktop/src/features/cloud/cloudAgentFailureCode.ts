/**
 * Stable categories a failed agent reply carries. Every member receives the
 * reply, so its text is only a neutral line; each viewer renders its own line
 * from the code, and only the agent's owner sees the reason.
 */
export const CLOUD_AGENT_FAILURE_CODES = [
  'provider_auth_rejected',
  'missing_provider_auth',
  'hosted_credentials_unavailable',
  'model_unavailable',
  'model_provider_error',
  'sandbox_error',
  'failed',
] as const;

export type CloudAgentFailureCode = (typeof CLOUD_AGENT_FAILURE_CODES)[number];

/** A known failure code, or null for a missing or unknown value. */
export function cloudAgentFailureCodeValue(value: unknown): CloudAgentFailureCode | null {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (CLOUD_AGENT_FAILURE_CODES as readonly string[]).includes(code)
    ? code as CloudAgentFailureCode
    : null;
}

/** The `failureCode` field a wire payload or stored row carries, when it has one. */
export function cloudAgentFailureCodeField(value: unknown): { failureCode?: CloudAgentFailureCode } {
  const failureCode = cloudAgentFailureCodeValue(value);
  return failureCode ? { failureCode } : {};
}

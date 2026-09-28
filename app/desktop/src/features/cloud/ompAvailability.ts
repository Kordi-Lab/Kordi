// Servers that predate hosted OMP accounts answer the provider-auth routes
// (catalog, validate-key, test-route, login/*) with 404, and servers without
// hosted accounts configured answer 503 provider_auth_not_configured. Both mean
// the same thing to the owner, so every client maps them through this one
// helper. A 503 omp_unavailable is different: the OMP worker is briefly
// unreachable (restarting, for example), so it is reported as a retryable
// failure and never turns the page's OMP actions off.

export const OMP_UNAVAILABLE_MESSAGE = 'OMP is not available on this backend yet. Saved accounts still work; key verification, route tests and sign-in steps need a newer server.';

/** A missing route, or hosted accounts not configured. A 404 for a known login session is not this. */
export function isOmpUnavailableResponse(status: number, code?: string | null) {
  if (status === 404) return code !== 'login_not_found';
  return status === 503 && code === 'provider_auth_not_configured';
}

export class OmpUnavailableError extends Error {
  readonly ompUnavailable = true;

  constructor() {
    super(OMP_UNAVAILABLE_MESSAGE);
    this.name = 'OmpUnavailableError';
  }
}

export function isOmpUnavailableError(caught: unknown): boolean {
  return caught instanceof Error && (caught as { ompUnavailable?: unknown }).ompUnavailable === true;
}

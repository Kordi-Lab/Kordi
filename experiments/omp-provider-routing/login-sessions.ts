/**
 * Hosted OMP login sessions.
 *
 * Kordi's "Add account" flows run OMP's own per-provider login steps inside the
 * worker, relayed to the user's app as JSON steps. The implementation is split by
 * responsibility:
 *
 * - login-session-types.ts: steps, snapshots, claim material, the registry seam,
 *   and fixed error classifications.
 * - login-session-store.ts: session records, idle expiry, the concurrency cap, and
 *   claim-once hand-over.
 * - login-step-bridge.ts: the OAuthController-to-step bridge, the api-key flow, and
 *   manual-only hosted OMP logins.
 * - login-session-routes.ts: the `/login/*` HTTP handlers.
 *
 * Supporting modules: provider-endpoint.ts resolves the `baseUrl` and `api` stamped on
 * claimed material, and outbound-guard.ts guards every request a login makes.
 */
export * from './login-session-types';
export * from './login-session-store';
export * from './login-step-bridge';
export * from './login-session-routes';

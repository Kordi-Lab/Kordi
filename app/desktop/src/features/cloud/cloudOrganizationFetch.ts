// Every Cloud request made with a session names the organization it acts in
// (`Kordi-Organization`). When the server answers `409 organization_mismatch`
// the token and the selection disagree: the organization state is refreshed,
// the token is switched when needed, and the request is sent once more.
import { getOrganizationState } from '@/features/organizations/organizationStore';
import { cachedSessionSnapshot } from './session';

export const ORGANIZATION_HEADER = 'Kordi-Organization';
const ORGANIZATION_MISMATCH = 'organization_mismatch';

export type OrganizationMismatchRecovery = (
  tokenOrganizationId: string | null,
  failedToken: string,
) => Promise<{ accountId: string; token: string } | null>;

let recoveryOverride: OrganizationMismatchRecovery | null = null;

export function setOrganizationMismatchRecoveryForTests(next: OrganizationMismatchRecovery | null): void {
  recoveryOverride = next;
}

async function recover(tokenOrganizationId: string | null, failedToken: string) {
  if (recoveryOverride) return recoveryOverride(tokenOrganizationId, failedToken);
  // Loaded on demand: the recovery module depends on clients built on this transport.
  const { recoverOrganizationMismatch } = await import('@/features/organizations/organizationMismatch');
  return recoverOrganizationMismatch(tokenOrganizationId, failedToken);
}

/** The signed-in account this window acts for, when known. */
function requestAccountId(): string | null {
  return getOrganizationState().accountId ?? cachedSessionSnapshot()?.accountId ?? null;
}

/**
 * The organization to name on a request: the selection once the account's
 * organizations are loaded, before that the organization of the cached token.
 */
export function requestOrganizationId(): string | null {
  const state = getOrganizationState();
  const session = cachedSessionSnapshot();
  if (state.accountId && session && session.accountId !== state.accountId) return null;
  if (state.accountId && state.selectedOrganizationId) return state.selectedOrganizationId;
  return session?.organizationId?.trim() || null;
}

function bearerToken(headers: Headers): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(headers.get('authorization') ?? '');
  return match?.[1]?.trim() || null;
}

/** Copies `init` with one header set (or removed), keeping the caller's header shape. */
function withHeader(init: RequestInit | undefined, name: string, value: string | null): RequestInit {
  const source = init?.headers;
  let headers: HeadersInit;
  if (source instanceof Headers || Array.isArray(source)) {
    const next = new Headers(source);
    if (value === null) next.delete(name);
    else next.set(name, value);
    headers = next;
  } else {
    const record = Object.fromEntries(Object.entries(source ?? {})
      .filter(([key]) => key.toLowerCase() !== name.toLowerCase()));
    headers = value === null ? record : { ...record, [name]: value };
  }
  return { ...init, headers };
}

function isReplayable(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (input instanceof Request) return false;
  const body = init?.body;
  return !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream);
}

async function mismatchOrganization(response: Response): Promise<{ organizationId: string | null } | null> {
  if (response.status !== 409) return null;
  try {
    const body = await response.clone().json() as { errorCode?: unknown; organizationId?: unknown };
    if (body?.errorCode !== ORGANIZATION_MISMATCH) return null;
    return { organizationId: typeof body.organizationId === 'string' ? body.organizationId : null };
  } catch {
    return null;
  }
}

/** Wraps a Cloud fetch so requests with a bearer token carry the organization header. */
export function withOrganizationHeader(fetchImpl: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const token = bearerToken(headers);
    if (!token) return fetchImpl(input, init);
    const callerOrganization = headers.has(ORGANIZATION_HEADER);
    const accountId = requestAccountId();
    const organizationId = callerOrganization ? null : requestOrganizationId();
    const response = await fetchImpl(
      input,
      organizationId && !(input instanceof Request) ? withHeader(init, ORGANIZATION_HEADER, organizationId) : init,
    );
    const mismatch = await mismatchOrganization(response);
    if (!mismatch || !isReplayable(input, init) || init?.signal?.aborted) return response;
    const recovered = await recover(mismatch.organizationId, token).catch(() => null);
    if (!recovered || init?.signal?.aborted) return response;
    // Never replay a request as another account; with no known account only the header may change.
    if (accountId ? recovered.accountId !== accountId : recovered.token !== token) return response;
    let retry = withHeader(init, 'authorization', `Bearer ${recovered.token}`);
    if (!callerOrganization) retry = withHeader(retry, ORGANIZATION_HEADER, requestOrganizationId());
    return fetchImpl(input, retry);
  };
}

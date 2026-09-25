/**
 * Process-wide outbound request guard for the hosted worker.
 *
 * OMP's provider logins, key probes, and transports call the global `fetch` (most
 * ignore `OAuthController.fetch`), and some of them take a URL from the user, such
 * as a custom base URL or an enterprise domain. Without a guard, a login could make
 * the worker send the user's key to a cloud metadata address or an internal
 * service. `installWorkerFetchGuard` replaces the process's global `fetch` with
 * `createGuardedFetch`, which reuses custom-endpoint.ts's resolve-and-block checks:
 *
 * - every target must be https on a public DNS name: no IP literals, no embedded
 *   credentials, no reserved suffixes such as `.internal` or `.local`;
 * - the name is resolved immediately before each attempt, and every address must be
 *   publicly routable (loopback, private, link-local, CGNAT, multicast, reserved, and
 *   documentation ranges are refused, including IPv4-mapped IPv6 forms);
 * - the runtime never follows a redirect itself: each attempt goes only to the
 *   origin that was just validated, and up to `MAX_REDIRECTS` hops are followed
 *   manually with every hop validated the same way. Credential headers are dropped
 *   when a hop changes origin.
 *
 * A refusal throws `CustomEndpointError` without sending anything. The residual risk
 * documented in custom-endpoint.ts applies: the runtime resolves the name again when
 * it connects, so production must also keep the worker on an egress-restricted
 * network.
 */
import {
  assertPublicHost,
  CustomEndpointError,
  isBlockedAddress,
  parsePublicHttpsUrl,
  systemResolver,
  type AddressPolicy,
  type EndpointFetch,
  type HostResolver,
} from './custom-endpoint';

export const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'x-goog-api-key'];
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location'];

export type GuardedFetchOptions = {
  resolver?: HostResolver;
  isBlocked?: AddressPolicy;
  /** The fetch that performs each validated attempt; defaults to the global fetch at call time. */
  baseFetch?: EndpointFetch;
  maxRedirects?: number;
};

type Attempt = { method: string; headers: Headers; body: BodyInit | null; replayable: boolean };

function firstAttempt(input: string | URL | Request, init: RequestInit | undefined): Attempt {
  const request = input instanceof Request ? input : undefined;
  const body = init?.body ?? null;
  return {
    method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
    headers: new Headers(init?.headers ?? request?.headers),
    body,
    // A stream (including a Request's own body) cannot be sent twice.
    replayable: !(body instanceof ReadableStream) && !(init?.body === undefined && request?.body),
  };
}

/** Applies the fetch standard's method and header rules for one redirect hop. */
function redirectedAttempt(attempt: Attempt, status: number, from: URL, to: URL): Attempt {
  const next = { ...attempt, headers: new Headers(attempt.headers) };
  const becomesGet = (status === 303 && next.method !== 'HEAD')
    || ((status === 301 || status === 302) && next.method === 'POST');
  if (becomesGet) {
    next.method = 'GET';
    next.body = null;
    next.replayable = true;
    for (const name of BODY_HEADERS) next.headers.delete(name);
  } else if (!next.replayable) {
    throw new TypeError('A streamed request body cannot follow a redirect.');
  }
  if (from.origin !== to.origin) {
    for (const name of CREDENTIAL_HEADERS) next.headers.delete(name);
  }
  return next;
}

/** A fetch that refuses non-public targets and validates every redirect hop. */
export function createGuardedFetch(options: GuardedFetchOptions = {}): EndpointFetch {
  const resolver = options.resolver ?? systemResolver;
  const isBlocked = options.isBlocked ?? isBlockedAddress;
  const baseFetch: EndpointFetch = options.baseFetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const validate = async (target: URL) => {
    const url = parsePublicHttpsUrl(target);
    await assertPublicHost(url.hostname, resolver, isBlocked);
  };

  return async function guardedFetch(input, init) {
    // Bun's `unix` option would send the request to a local socket whatever the URL says.
    if (init && 'unix' in init) throw new CustomEndpointError();
    const request = input instanceof Request ? input : undefined;
    let url = new URL(request ? request.url : String(input));
    const mode = init?.redirect ?? request?.redirect ?? 'follow';
    await validate(url);
    let response = await baseFetch(input, { ...init, redirect: 'manual' });
    if (mode === 'manual') return response;

    let attempt = firstAttempt(input, init);
    for (let hops = 0; REDIRECT_STATUSES.has(response.status); hops += 1) {
      const location = response.headers.get('location');
      if (!location) return response;
      await response.body?.cancel();
      if (mode === 'error') throw new TypeError('The request was redirected and redirects are refused.');
      if (hops >= maxRedirects) throw new CustomEndpointError();
      const next = new URL(location, url);
      attempt = redirectedAttempt(attempt, response.status, url, next);
      await validate(next);
      url = next;
      response = await baseFetch(next.href, {
        ...init,
        method: attempt.method,
        headers: attempt.headers,
        body: attempt.body,
        signal: init?.signal ?? request?.signal,
        redirect: 'manual',
      });
    }
    return response;
  };
}

let installed: { guard: EndpointFetch; original: typeof globalThis.fetch } | undefined;
let fallback: EndpointFetch | undefined;

/**
 * Replaces the process's global `fetch` with a guarded one wrapping the current
 * global. Returns a function that restores the original. Installing twice throws.
 */
export function installWorkerFetchGuard(options: GuardedFetchOptions = {}): () => void {
  if (installed) throw new Error('The worker fetch guard is already installed.');
  const original = globalThis.fetch;
  const guard = createGuardedFetch({ ...options, baseFetch: options.baseFetch ?? original.bind(globalThis) });
  // `preconnect` would open a connection to an unvalidated host, so it does nothing here.
  globalThis.fetch = Object.assign(guard, { preconnect: () => {} }) as typeof globalThis.fetch;
  installed = { guard, original };
  return () => {
    if (installed?.guard !== guard) return;
    globalThis.fetch = original;
    installed = undefined;
  };
}

/**
 * The guarded fetch to hand to OMP (`OAuthController.fetch`, key probes): the
 * installed process guard, or a guard around the current global fetch when none is
 * installed.
 */
export function workerFetch(): EndpointFetch {
  if (installed) return installed.guard;
  fallback ??= createGuardedFetch();
  return fallback;
}

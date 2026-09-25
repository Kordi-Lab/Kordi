/**
 * Network fakes for the worker tests. No test reaches DNS or the network: names
 * resolve through a fixed table, and requests land on a stub.
 *
 * Tests use RFC 5737 / RFC 3849 documentation addresses (192.0.2.x, 198.51.100.x,
 * 2001:db8::) as stand-ins for public addresses. Production refuses those ranges, so
 * `documentationAsPublic` applies the production policy to every other address.
 */
import { isBlockedAddress, isDocumentationAddress, type AddressPolicy, type HostResolver } from './custom-endpoint';
import { installWorkerFetchGuard } from './outbound-guard';

export const documentationAsPublic: AddressPolicy = (address) => !isDocumentationAddress(address) && isBlockedAddress(address);

export function fakeResolver(records: Record<string, string[]>): HostResolver & { calls: string[] } {
  const calls: string[] = [];
  const resolve = (async (hostname: string) => {
    calls.push(hostname);
    const addresses = records[hostname];
    if (!addresses) throw new Error('ENOTFOUND');
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }) as HostResolver & { calls: string[] };
  resolve.calls = calls;
  return resolve;
}

export type SeenRequest = { url: string; method: string; headers: Headers; redirect?: RequestRedirect };
export type StubResponder = (request: SeenRequest) => Response | Promise<Response>;

/** A stub fetch that records every request it receives. */
export function stubFetch(respond: StubResponder) {
  const seen: SeenRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const entry: SeenRequest = {
      url: request ? request.url : String(input),
      method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers ?? request?.headers),
      redirect: init?.redirect,
    };
    seen.push(entry);
    return respond(entry);
  };
  return { fetch, seen };
}

/**
 * Installs the worker fetch guard over a stub for one test, as the worker does in
 * production. Call `restore` in a `finally`.
 */
export function guardedNetwork(records: Record<string, string[]>, respond: StubResponder) {
  const stub = stubFetch(respond);
  const resolver = fakeResolver(records);
  const restore = installWorkerFetchGuard({ resolver, isBlocked: documentationAsPublic, baseFetch: stub.fetch });
  return { seen: stub.seen, resolver, restore };
}

export function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

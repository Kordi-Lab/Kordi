/**
 * Guards the Custom API route against server-side request forgery, and supplies the
 * resolve-and-block checks that outbound-guard.ts applies to every worker request.
 *
 * A custom endpoint must be an https URL on a public DNS name. The name is
 * normalised, literal addresses are refused, and every address the name resolves
 * to must be publicly routable. The request itself goes through a fetch wrapper
 * that re-resolves the name immediately before each attempt (to catch a DNS rebind
 * between validation and use) and refuses redirects.
 *
 * Residual risk: the runtime performs its own lookup when it connects, so a rebind
 * that lands between the wrapper's check and that connect cannot be seen here.
 * Production deployments must additionally keep the worker on an egress-restricted
 * network.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type ResolvedAddress = { address: string; family: number };
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;
/** Returns true when a resolved address must not be contacted; `isBlockedAddress` in production. */
export type AddressPolicy = (address: string) => boolean;
export type EndpointFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/** `blocked` records a refusal; `signal` aborts on it so the caller's retries stop at once. */
export type GuardedFetch = EndpointFetch & { blocked: boolean; readonly signal: AbortSignal };

const LOOKUP_TIMEOUT_MS = 5_000;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const RESERVED_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'arpa', 'test', 'invalid', 'onion'];

/** The single error every rejected endpoint produces. */
export class CustomEndpointError extends Error {
  constructor() {
    super('invalid_custom_endpoint');
    this.name = 'CustomEndpointError';
  }
}

/** Resolves every A and AAAA record through the system resolver, bounded by a timeout. */
export const systemResolver: HostResolver = async (hostname) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CustomEndpointError()), LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookup(hostname, { all: true, verbatim: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

function parseIPv4(text: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return null;
  const octets = text.split('.').map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Expands an IPv6 address (with optional zone or dotted IPv4 tail) into eight 16-bit groups. */
function parseIPv6(address: string): number[] | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':')
    .map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN)));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  return fill >= 1 ? [...head, ...new Array<number>(fill).fill(0), ...rest] : null;
}

function isNonPublicIPv4([a, b, c]: number[]): boolean {
  return a === 0 // unspecified and "this network"
    || a === 10 // private
    || (a === 100 && b! >= 64 && b! <= 127) // carrier-grade NAT
    || a === 127 // loopback
    || (a === 169 && b === 254) // link-local, including cloud metadata
    || (a === 172 && b! >= 16 && b! <= 31) // private
    || (a === 192 && b === 168) // private
    || (a === 192 && b === 0 && c === 0) // protocol assignments
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || a! >= 224; // multicast, reserved, broadcast
}

/** RFC 5737 documentation ranges: never routed publicly, so they are refused too. */
function isDocumentationIPv4([a, b, c]: number[]): boolean {
  return (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function embeddedIPv4(groups: number[], high: number, low: number): number[] {
  return [groups[high]! >> 8, groups[high]! & 0xff, groups[low]! >> 8, groups[low]! & 0xff];
}

/** The IPv4 address an IPv4-compatible, IPv4-mapped, NAT64, or 6to4 address embeds, if any. */
function embeddedIPv4Of(groups: number[]): number[] | null {
  const [g0, g1, g2, g3, g4, g5] = groups as [number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    return embeddedIPv4(groups, 6, 7); // unspecified, loopback, IPv4-compatible, IPv4-mapped
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embeddedIPv4(groups, 6, 7);
  if (g0 === 0x2002) return embeddedIPv4(groups, 1, 2);
  return null;
}

function isNonPublicIPv6(groups: number[]): boolean {
  const g0 = groups[0]!;
  return (g0 & 0xffc0) === 0xfe80 // link-local
    || (g0 & 0xffc0) === 0xfec0 // site-local
    || (g0 & 0xfe00) === 0xfc00 // unique local
    || (g0 & 0xff00) === 0xff00; // multicast
}

function isDocumentationIPv6(groups: number[]): boolean {
  return groups[0] === 0x2001 && groups[1] === 0x0db8;
}

/**
 * The IPv4 octets `address` denotes directly or embeds (IPv4-mapped, NAT64, 6to4),
 * otherwise its IPv6 groups; `null` when it is not an IP address.
 */
function addressForm(address: string): { v4: number[] } | { v6: number[] } | null {
  const family = isIP(address.replace(/%.*$/, ''));
  if (family === 4) {
    const v4 = parseIPv4(address);
    return v4 && { v4 };
  }
  const v6 = family === 6 ? parseIPv6(address) : null;
  if (!v6) return null;
  const embedded = embeddedIPv4Of(v6);
  return embedded ? { v4: embedded } : { v6 };
}

/** True for an RFC 5737 or RFC 3849 documentation address, including its IPv4-mapped forms. */
export function isDocumentationAddress(address: string): boolean {
  const form = addressForm(address);
  return !!form && ('v4' in form ? isDocumentationIPv4(form.v4) : isDocumentationIPv6(form.v6));
}

/** True unless `address` is a publicly routable IPv4 or IPv6 address; unparseable input is blocked. */
export function isBlockedAddress(address: string): boolean {
  const form = addressForm(address);
  if (!form) return true;
  return 'v4' in form
    ? isNonPublicIPv4(form.v4) || isDocumentationIPv4(form.v4)
    : isNonPublicIPv6(form.v6) || isDocumentationIPv6(form.v6);
}

/** Lowercases, strips one trailing dot, and checks the name has a public DNS shape. */
function normalizedPublicHostname(hostname: string): string | null {
  let host = hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || host.length > 253 || host.startsWith('[') || isIP(host) !== 0) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  const topLevel = labels[labels.length - 1]!;
  if (!TOP_LEVEL_LABEL.test(topLevel)) return null;
  if (RESERVED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  return host;
}

/**
 * Validates an outbound request target without network access: https only, no
 * embedded credentials, and a public DNS name (never an IP literal or a reserved
 * suffix such as `.internal` or `.local`). Returns it with a normalised host.
 */
export function parsePublicHttpsUrl(target: unknown): URL {
  let url: URL;
  try {
    url = new URL(target instanceof URL ? target.href : String(target));
  } catch {
    throw new CustomEndpointError();
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new CustomEndpointError();
  const host = normalizedPublicHostname(url.hostname);
  if (!host) throw new CustomEndpointError();
  url.hostname = host;
  return url;
}

/** Validates a base URL: a public https target that also carries no query string or fragment. */
export function parseCustomEndpoint(baseURL: unknown): URL {
  if (typeof baseURL !== 'string') throw new CustomEndpointError();
  const url = parsePublicHttpsUrl(baseURL);
  if (url.search || url.hash) throw new CustomEndpointError();
  return url;
}

/** Rejects unless every address `hostname` resolves to is publicly routable. */
export async function assertPublicHost(
  hostname: string,
  resolver: HostResolver = systemResolver,
  isBlocked: AddressPolicy = isBlockedAddress,
): Promise<void> {
  let records: ResolvedAddress[];
  try {
    records = await resolver(hostname);
  } catch {
    throw new CustomEndpointError();
  }
  if (records.length === 0 || records.some((record) => isBlocked(record.address))) {
    throw new CustomEndpointError();
  }
}

/** Parses the endpoint and checks its resolution before any credential is sent. */
export async function resolvePublicEndpoint(
  baseURL: unknown,
  resolver: HostResolver = systemResolver,
  isBlocked: AddressPolicy = isBlockedAddress,
): Promise<URL> {
  const url = parseCustomEndpoint(baseURL);
  await assertPublicHost(url.hostname, resolver, isBlocked);
  return url;
}

/**
 * A fetch for one validated endpoint: only its origin is reachable, the name is
 * re-resolved before every attempt, and redirects are errors. A refusal sets
 * `blocked` and aborts `signal`, so the caller stops retrying and can report it as an
 * endpoint failure rather than a provider one.
 */
export function createPublicEndpointFetch(
  endpoint: URL,
  resolver: HostResolver = systemResolver,
  baseFetch: EndpointFetch = globalThis.fetch,
  isBlocked: AddressPolicy = isBlockedAddress,
): GuardedFetch {
  const refusal = new AbortController();
  const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    try {
      if (target.origin !== endpoint.origin) throw new CustomEndpointError();
      await assertPublicHost(endpoint.hostname, resolver, isBlocked);
    } catch (error) {
      guarded.blocked = true;
      refusal.abort(error);
      throw error;
    }
    return baseFetch(input, { ...init, redirect: 'error' });
  }) as GuardedFetch;
  guarded.blocked = false;
  Object.defineProperty(guarded, 'signal', { value: refusal.signal });
  return guarded;
}

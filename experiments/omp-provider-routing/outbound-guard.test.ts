import { describe, expect, test } from 'bun:test';
import { createGuardedFetch, installWorkerFetchGuard, MAX_REDIRECTS, workerFetch } from './outbound-guard';
import { documentationAsPublic, fakeResolver, redirectTo, stubFetch } from './network-test-fixtures';

// Outbound guard: every request is checked before the stub sees it; nothing reaches DNS or the network.

const HOSTS = {
  'api.example.com': ['192.0.2.10', '2001:db8::10'],
  'cdn.example.net': ['198.51.100.7'],
  'metadata.example.com': ['169.254.169.254'],
  'internal.example.com': ['10.0.0.5'],
  'mapped.example.com': ['::ffff:127.0.0.1'],
};

function guard(respond: Parameters<typeof stubFetch>[0] = () => new Response('{}')) {
  const stub = stubFetch(respond);
  const fetch = createGuardedFetch({ resolver: fakeResolver(HOSTS), isBlocked: documentationAsPublic, baseFetch: stub.fetch });
  return { fetch, seen: stub.seen };
}

describe('outbound guard targets', () => {
  test('a normal https call passes through with redirects handled by the guard', async () => {
    const { fetch, seen } = guard(() => Response.json({ data: [] }));
    const response = await fetch('https://api.example.com/v1/models?limit=5', { headers: { authorization: 'Bearer synthetic' } });
    expect(await response.json()).toEqual({ data: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'https://api.example.com/v1/models?limit=5', redirect: 'manual' });
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer synthetic');
  });

  test.each([
    ['plain-http metadata address', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['https metadata literal', 'https://169.254.169.254/latest/meta-data/'],
    ['name resolving to the metadata address', 'https://metadata.example.com/latest/meta-data/'],
    ['name resolving to a private address', 'https://internal.example.com/v1/models'],
    ['name resolving to IPv4-mapped loopback', 'https://mapped.example.com/v1/models'],
    ['reserved suffix', 'https://metadata.internal/v1/models'],
    ['local suffix', 'https://printer.local/v1/models'],
    ['IPv6 loopback literal', 'https://[::1]/v1/models'],
    ['embedded credentials', 'https://user:secret@api.example.com/v1/models'],
    ['unresolvable name', 'https://missing.example.com/v1/models'],
    ['non-http scheme', 'file:///etc/passwd'],
  ])('refuses a %s without sending', async (_name, url) => {
    const { fetch, seen } = guard();
    await expect(fetch(url)).rejects.toThrow('invalid_custom_endpoint');
    expect(seen).toHaveLength(0);
  });

  test('refuses a Bun unix-socket request whatever the URL says', async () => {
    const { fetch, seen } = guard();
    await expect(fetch('https://api.example.com/v1', { unix: '/var/run/docker.sock' } as RequestInit))
      .rejects.toThrow('invalid_custom_endpoint');
    expect(seen).toHaveLength(0);
  });
});

describe('outbound guard redirects', () => {
  test('a redirect to a private address is refused before the second request', async () => {
    const { fetch, seen } = guard(() => redirectTo('http://169.254.169.254/latest/meta-data/'));
    await expect(fetch('https://api.example.com/v1/models')).rejects.toThrow('invalid_custom_endpoint');
    expect(seen.map((request) => request.url)).toEqual(['https://api.example.com/v1/models']);

    const internal = guard(() => redirectTo('https://internal.example.com/admin'));
    await expect(internal.fetch('https://api.example.com/v1/models')).rejects.toThrow('invalid_custom_endpoint');
    expect(internal.seen).toHaveLength(1);
  });

  test('public hops are followed, a 303 becomes GET, and credentials stay on their origin', async () => {
    const { fetch, seen } = guard((request) => {
      if (request.url === 'https://api.example.com/v1/start') return redirectTo('/v1/next', 307);
      if (request.url === 'https://api.example.com/v1/next') return redirectTo('https://cdn.example.net/result', 303);
      return new Response('done');
    });
    const response = await fetch('https://api.example.com/v1/start', {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
      body: '{"probe":true}',
    });
    expect(await response.text()).toBe('done');
    expect(seen.map((request) => [request.method, request.url])).toEqual([
      ['POST', 'https://api.example.com/v1/start'],
      ['POST', 'https://api.example.com/v1/next'],
      ['GET', 'https://cdn.example.net/result'],
    ]);
    expect(seen[1]!.headers.get('authorization')).toBe('Bearer synthetic');
    expect(seen[2]!.headers.get('authorization')).toBeNull();
    expect(seen[2]!.headers.get('content-type')).toBeNull();
    for (const request of seen) expect(request.redirect).toBe('manual');
  });

  test(`at most ${MAX_REDIRECTS} redirects are followed`, async () => {
    let hop = 0;
    const { fetch, seen } = guard(() => redirectTo(`https://api.example.com/hop/${(hop += 1)}`));
    await expect(fetch('https://api.example.com/hop/0')).rejects.toThrow('invalid_custom_endpoint');
    expect(seen).toHaveLength(MAX_REDIRECTS + 1);
  });

  test('redirect modes error and manual keep their fetch meaning', async () => {
    const { fetch, seen } = guard(() => redirectTo('https://cdn.example.net/elsewhere'));
    await expect(fetch('https://api.example.com/v1', { redirect: 'error' })).rejects.toThrow(TypeError);
    const manual = await fetch('https://api.example.com/v1', { redirect: 'manual' });
    expect(manual.status).toBe(302);
    expect(seen).toHaveLength(2);
  });
});

describe('process installation', () => {
  test('installing replaces the global fetch, workerFetch returns the guard, and restore undoes it', async () => {
    const original = globalThis.fetch;
    const stub = stubFetch(() => new Response('ok'));
    const restore = installWorkerFetchGuard({ resolver: fakeResolver(HOSTS), isBlocked: documentationAsPublic, baseFetch: stub.fetch });
    try {
      expect(globalThis.fetch).not.toBe(original);
      expect(workerFetch()).toBe(globalThis.fetch);
      expect(() => installWorkerFetchGuard()).toThrow('already installed');
      await expect(fetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('invalid_custom_endpoint');
      expect(await (await fetch('https://api.example.com/v1')).text()).toBe('ok');
      expect(stub.seen.map((request) => request.url)).toEqual(['https://api.example.com/v1']);
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(original);
  });
});

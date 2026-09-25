import { describe, expect, test } from 'bun:test';
import {
  createPublicEndpointFetch,
  isBlockedAddress,
  isDocumentationAddress,
  parseCustomEndpoint,
  resolvePublicEndpoint,
  type HostResolver,
} from './custom-endpoint';
import { documentationAsPublic, fakeResolver as resolver } from './network-test-fixtures';

// A fake resolver seam: no test here reaches DNS or the network. Documentation addresses
// stand in for public ones through `documentationAsPublic`; production refuses them.

const PUBLIC = { 'api.example.com': ['192.0.2.10', '2001:db8::10'] };

describe('custom endpoint shape', () => {
  test('a public https host is allowed and normalised', async () => {
    const endpoint = await resolvePublicEndpoint('https://API.Example.com./v1/', resolver(PUBLIC), documentationAsPublic);
    expect(endpoint.hostname).toBe('api.example.com');
    expect(endpoint.toString()).toBe('https://api.example.com/v1/');
  });

  test.each([
    ['trailing-dot localhost', 'https://localhost./v1'],
    ['compose service name without a dot', 'https://postgres/v1'],
    ['plain http', 'http://api.example.com/v1'],
    ['embedded credentials', 'https://user:secret@api.example.com/v1'],
    ['query string', 'https://api.example.com/v1?target=internal'],
    ['reserved suffix', 'https://metadata.internal/v1'],
    ['numeric top-level label', 'https://api.example.123/v1'],
    ['IPv4 literal', 'https://127.0.0.1/v1'],
    ['routable-looking IPv4 literal', 'https://192.0.2.10/v1'],
    ['decimal IPv4 literal', 'https://2130706433/v1'],
    ['hex IPv4 literal', 'https://0x7f.0.0.1/v1'],
    ['short IPv4 literal', 'https://127.1/v1'],
    ['IPv6 literal', 'https://[::1]/v1'],
    ['IPv4-mapped IPv6 literal', 'https://[::ffff:127.0.0.1]/v1'],
  ])('rejects %s before any lookup', (_name, baseUrl) => {
    expect(() => parseCustomEndpoint(baseUrl)).toThrow('invalid_custom_endpoint');
  });
});

describe('custom endpoint resolution', () => {
  test.each([
    ['127.0.0.1.nip.io', ['127.0.0.1']],
    ['169.254.169.254.nip.io', ['169.254.169.254']],
    ['private.example.com', ['10.1.2.3']],
    ['mixed.example.com', ['192.0.2.10', '192.168.1.10']],
    ['cgnat.example.com', ['100.64.0.1']],
    ['mapped.example.com', ['::ffff:127.0.0.1']],
    ['ula.example.com', ['fd00::1']],
  ])('rejects %s when it resolves to a non-public address', async (hostname, addresses) => {
    const lookup = resolver({ [hostname]: addresses });
    await expect(resolvePublicEndpoint(`https://${hostname}/v1`, lookup, documentationAsPublic))
      .rejects.toThrow('invalid_custom_endpoint');
    expect(lookup.calls).toEqual([hostname]);
  });

  test('rejects a name that does not resolve', async () => {
    await expect(resolvePublicEndpoint('https://missing.example.com/v1', resolver({})))
      .rejects.toThrow('invalid_custom_endpoint');
  });

  test('classifies every non-public range, including IPv4-mapped IPv6', () => {
    const blocked = [
      '0.0.0.0', '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254',
      '100.64.0.1', '100.127.255.255', '192.0.0.8', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
      '::', '::1', 'fe80::1', 'fe80::1%lo0', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:c0a8:101::1', 'not-an-address',
    ];
    for (const address of blocked) {
      expect([address, isBlockedAddress(address), documentationAsPublic(address)]).toEqual([address, true, true]);
    }
  });

  test('documentation ranges are refused in production and stand in for public addresses in tests', () => {
    const documentation = ['192.0.2.1', '198.51.100.7', '203.0.113.9', '2001:db8::1', '::ffff:192.0.2.1', '64:ff9b::c000:201'];
    for (const address of documentation) {
      expect([address, isDocumentationAddress(address), isBlockedAddress(address), documentationAsPublic(address)])
        .toEqual([address, true, true, false]);
    }
    for (const address of ['10.0.0.1', '::1', 'not-an-address']) expect(isDocumentationAddress(address)).toBe(false);
  });
});

describe('custom endpoint fetch', () => {
  const endpoint = new URL('https://api.example.com/v1');

  test('refuses redirects and keeps requests on the validated origin', async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const guarded = createPublicEndpointFetch(endpoint, resolver(PUBLIC), async (input, init) => {
      seen.push([String(input), init]);
      return new Response('{}');
    }, documentationAsPublic);
    await guarded('https://api.example.com/v1/chat/completions', { method: 'POST', redirect: 'follow' });
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]?.redirect).toBe('error');
    expect(guarded.blocked).toBe(false);

    await expect(guarded('https://elsewhere.example.com/v1')).rejects.toThrow('invalid_custom_endpoint');
    expect(guarded.blocked).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test('catches a DNS rebind between validation and the request', async () => {
    let lookups = 0;
    const rebinding: HostResolver = async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? '192.0.2.10' : '127.0.0.1', family: 4 }];
    };
    const validated = await resolvePublicEndpoint('https://api.example.com/v1', rebinding, documentationAsPublic);
    let sent = 0;
    const guarded = createPublicEndpointFetch(validated, rebinding, async () => {
      sent += 1;
      return new Response('{}');
    }, documentationAsPublic);
    await expect(guarded('https://api.example.com/v1/chat/completions')).rejects.toThrow('invalid_custom_endpoint');
    expect(sent).toBe(0);
    expect(guarded.blocked).toBe(true);
    expect(guarded.signal.aborted).toBe(true);
  });
});

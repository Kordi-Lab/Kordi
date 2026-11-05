import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  ORGANIZATION_HEADER,
  setOrganizationMismatchRecoveryForTests,
  withOrganizationHeader,
} from '../src/features/cloud/cloudOrganizationFetch';
import {
  __setSessionBackendForTests,
  saveSession,
  switchSessionOrganization,
  type SessionStorageBackend,
  type StoredSession,
} from '../src/features/cloud/session';
import type { CloudOrganization } from '../src/features/organizations/organizationClient';
import { recoverOrganizationMismatch } from '../src/features/organizations/organizationMismatch';
import {
  getOrganizationState,
  organizationSelectionKey,
  resetOrganizationAccount,
  selectOrganization,
  setAccountOrganizations,
  type OrganizationStorage,
} from '../src/features/organizations/organizationStore';
import { alignSessionOrganization, switchOrganization } from '../src/features/organizations/organizationSwitch';
import { switchedSession } from '../src/features/organizations/organizationToken';

const personal: CloudOrganization = {
  organizationId: 'org_personal', name: 'Personal', kind: 'personal', role: 'owner', memberCount: 1,
};
const team: CloudOrganization = {
  organizationId: 'org_team', name: 'Example team', kind: 'team', role: 'member', memberCount: 3,
};
const session: StoredSession = {
  token: 'tok_personal',
  accountId: 'acct_a',
  expiresAt: '2099-01-01T00:00:00Z',
  deviceId: 'dev_a',
  refreshToken: 'rt_a',
  clientId: 'kordi-desktop',
  tokenEndpoint: 'https://cloud.example.test/v1/cloud/auth/app/token',
};

function memoryStorage(): OrganizationStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

function signedIn(selected: string | null = null, storage = memoryStorage()) {
  setAccountOrganizations('acct_a', [personal, team], storage);
  if (selected) selectOrganization('acct_a', selected, storage);
  return storage;
}

type Call = { url: string; authorization: string | null; organization: string | null; init?: RequestInit };

function recordingFetch(responses: Response[]): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get('authorization'),
      organization: headers.get(ORGANIZATION_HEADER),
      init,
    });
    return responses.shift() ?? new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function mismatch(organizationId: string): Response {
  return new Response(JSON.stringify({
    errorCode: 'organization_mismatch',
    message: 'Your organization changed. Refresh and try again.',
    organizationId,
  }), { status: 409 });
}

afterEach(() => {
  resetOrganizationAccount(null);
  setOrganizationMismatchRecoveryForTests(null);
  __setSessionBackendForTests(null);
});

test('requests with a session name the selected organization', async () => {
  signedIn('org_team');
  const { calls, fetchImpl } = recordingFetch([]);
  const fetchWithOrganization = withOrganizationHeader(fetchImpl);

  await fetchWithOrganization('https://cloud.example.test/v2/chat/sync', {
    method: 'GET',
    headers: { Authorization: 'Bearer tok_team' },
  });
  await fetchWithOrganization('https://cloud.example.test/v1/cloud/auth/app/token', { method: 'POST' });
  await fetchWithOrganization('https://cloud.example.test/v2/chat/sync', {
    headers: { authorization: 'Bearer tok_team', [ORGANIZATION_HEADER]: 'org_explicit' },
  });

  assert.deepEqual(calls.map((call) => [call.authorization, call.organization]), [
    ['Bearer tok_team', 'org_team'],
    [null, null],
    ['Bearer tok_team', 'org_explicit'],
  ]);
  // The caller's header object keeps its shape and keys.
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer tok_team');
});

test('requests send no organization while none is known', async () => {
  const { calls, fetchImpl } = recordingFetch([]);
  await withOrganizationHeader(fetchImpl)('https://cloud.example.test/v2/chat/sync', {
    headers: { authorization: 'Bearer tok_any' },
  });
  assert.equal(calls[0].organization, null);
});

test('an organization mismatch refreshes, switches and retries once', async () => {
  signedIn('org_personal');
  const recoveries: Array<[string | null, string]> = [];
  setOrganizationMismatchRecoveryForTests(async (tokenOrganizationId, failedToken) => {
    recoveries.push([tokenOrganizationId, failedToken]);
    selectOrganization('acct_a', 'org_team', memoryStorage());
    return { accountId: 'acct_a', token: 'tok_team' };
  });
  const { calls, fetchImpl } = recordingFetch([mismatch('org_team'), new Response('{"ok":true}', { status: 200 })]);

  const response = await withOrganizationHeader(fetchImpl)('https://cloud.example.test/v2/chat/messages', {
    method: 'POST',
    headers: { authorization: 'Bearer tok_personal', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(recoveries, [['org_team', 'tok_personal']]);
  assert.deepEqual(calls.map((call) => [call.authorization, call.organization, call.init?.body]), [
    ['Bearer tok_personal', 'org_personal', '{"text":"hello"}'],
    ['Bearer tok_team', 'org_team', '{"text":"hello"}'],
  ]);
});

test('a second mismatch is returned instead of retrying again', async () => {
  signedIn('org_team');
  let recoveries = 0;
  setOrganizationMismatchRecoveryForTests(async () => {
    recoveries += 1;
    return { accountId: 'acct_a', token: 'tok_team' };
  });
  const { calls, fetchImpl } = recordingFetch([mismatch('org_personal'), mismatch('org_personal')]);

  const response = await withOrganizationHeader(fetchImpl)('https://cloud.example.test/v2/chat/sync', {
    headers: { authorization: 'Bearer tok_team' },
  });

  assert.equal(response.status, 409);
  assert.equal(calls.length, 2);
  assert.equal(recoveries, 1);
});

test('other conflicts and recoveries for another account are not retried', async () => {
  signedIn('org_team');
  setOrganizationMismatchRecoveryForTests(async () => ({ accountId: 'acct_b', token: 'tok_b' }));
  const conflict = recordingFetch([new Response('{"errorCode":"conflict"}', { status: 409 })]);
  const other = recordingFetch([mismatch('org_personal')]);

  assert.equal((await withOrganizationHeader(conflict.fetchImpl)('https://cloud.example.test/v2/chat/sync', {
    headers: { authorization: 'Bearer tok_team' },
  })).status, 409);
  assert.equal((await withOrganizationHeader(other.fetchImpl)('https://cloud.example.test/v2/chat/sync', {
    headers: { authorization: 'Bearer tok_team' },
  })).status, 409);
  assert.equal(conflict.calls.length, 1);
  assert.equal(other.calls.length, 1);
});

test('recovery switches the token only when it still acts elsewhere', async () => {
  signedIn('org_team');
  const switched: string[] = [];
  const deps = {
    loadSession: async () => session,
    refreshOrganizations: async () => {},
    switchSession: async (organizationId: string) => {
      switched.push(organizationId);
      return { ...session, token: 'tok_team', organizationId };
    },
  };

  assert.deepEqual(await recoverOrganizationMismatch('org_personal', 'tok_personal', deps), {
    accountId: 'acct_a', token: 'tok_team',
  });
  assert.deepEqual(switched, ['org_team']);

  // The token already acts in the selection: only the header was stale.
  assert.deepEqual(await recoverOrganizationMismatch('org_team', 'tok_personal', deps), {
    accountId: 'acct_a', token: 'tok_personal',
  });
  assert.deepEqual(switched, ['org_team']);
});

test('selecting an organization switches the token first and keeps the selection when that fails', async () => {
  signedIn();
  assert.equal(getOrganizationState().selectedOrganizationId, 'org_personal');

  const failing = {
    loadSession: async () => session,
    switchSession: async (): Promise<StoredSession> => { throw new Error('network_error'); },
  };
  assert.equal(await switchOrganization('acct_a', 'org_team', failing), false);
  assert.equal(getOrganizationState().selectedOrganizationId, 'org_personal');

  const switched: string[] = [];
  const working = {
    loadSession: async () => session,
    switchSession: async (organizationId: string) => {
      switched.push(organizationId);
      return { ...session, token: 'tok_team', organizationId };
    },
  };
  assert.equal(await switchOrganization('acct_a', 'org_team', working), true);
  assert.deepEqual(switched, ['org_team']);
  assert.equal(getOrganizationState().selectedOrganizationId, 'org_team');

  // A server without the exchange keeps the earlier behavior.
  const unsupported = {
    loadSession: async () => ({ ...session, organizationId: 'org_team' }),
    switchSession: async (): Promise<StoredSession> => { throw new Error('unsupported'); },
  };
  assert.equal(await switchOrganization('acct_a', 'org_personal', unsupported), true);
  assert.equal(getOrganizationState().selectedOrganizationId, 'org_personal');
});

test('a failed alignment shows the token organization without changing the stored selection', async () => {
  const storage = signedIn('org_team');
  await alignSessionOrganization('acct_a', {
    loadSession: async () => session,
    switchSession: async (): Promise<StoredSession> => { throw new Error('organization_not_found'); },
  });
  assert.equal(getOrganizationState().selectedOrganizationId, 'org_personal');
  assert.equal(storage.values.get(organizationSelectionKey('acct_a')), 'org_team');
});

test('a session switch retries once from the stored session after another window refreshed', async () => {
  let stored: StoredSession = { ...session };
  const attempts: string[] = [];
  const backend: SessionStorageBackend = {
    load: async () => stored,
    save: async (next) => { stored = next; },
    clear: async () => {},
    switchOrganization: async (from, organizationId) => {
      attempts.push(from.token);
      if (from.token !== stored.token) throw new Error('session_changed');
      stored = { ...stored, token: 'tok_team', organizationId };
      return stored;
    },
  };
  __setSessionBackendForTests(backend);
  await saveSession({ ...session });
  // Another window refreshed: the stored session moved on.
  stored = { ...session, token: 'tok_refreshed', refreshToken: 'rt_rotated' };

  const next = await switchSessionOrganization('org_team');
  assert.deepEqual(attempts, ['tok_personal', 'tok_refreshed']);
  assert.equal(next.token, 'tok_team');
  assert.equal(next.refreshToken, 'rt_rotated');
  assert.equal(next.organizationId, 'org_team');
});

test('a switch response for another account is rejected', () => {
  const body = {
    access_token: 'tok_other', expires_in: 3600, account_id: 'acct_b', device_id: 'dev_a', organization_id: 'org_team',
  };
  assert.throws(() => switchedSession(session, 'org_team', 200, body, 0), /account_mismatch/);
  assert.throws(
    () => switchedSession(session, 'org_team', 404, { errorCode: 'organization_not_found' }, 0),
    /organization_not_found/,
  );
  const next = switchedSession(session, 'org_team', 200, { ...body, account_id: 'acct_a' }, 0);
  assert.equal(next.refreshToken, 'rt_a');
  assert.equal(next.organizationId, 'org_team');
  assert.equal(next.expiresAt, '1970-01-01T01:00:00.000Z');
});

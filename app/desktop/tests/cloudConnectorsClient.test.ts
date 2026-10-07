import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import {
  clearCloudAuthCapabilitiesCacheForTests,
  loadCloudAuthCapabilities,
} from '../src/features/cloud/cloudAuthCapabilities';
import {
  CloudConnectorsHttpClient,
  parseConnectorCallbackFragment,
  type CloudConnectorAuditEntry,
  type CloudConnectorSummary,
} from '../src/features/cloud/cloudConnectorsClient';
import type { DesktopInvoke, MacLocalConnectorsState } from '../src/features/connectors/connectorsClient';
import {
  connectorsClientForAccount,
  SERVICE_CONNECTORS_NEED_NEWER_SERVER,
} from '../src/features/connectors/connectorsClientSelection';
import {
  connectorAuditEntryFromCloud,
  connectorStateFromSummary,
  createCloudConnectorsClient,
  defaultConnectorAgentId,
  type ConnectorOAuthHandoff,
} from '../src/features/connectors/connectorsCloudClient';
import { connectorCatalog, connectorDefinition } from '../src/features/connectors/connectorsModel';

type FetchCall = { url: string; init: RequestInit | undefined };

function recordingFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  return { calls, fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers[name];
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

const ACCOUNT_ID = 'acct-1';
const TOKEN = 'session-abc';

function summary(overrides: Partial<CloudConnectorSummary> = {}): CloudConnectorSummary {
  return {
    connectorId: 'conn-github',
    provider: 'github',
    status: 'connected',
    readScopes: ['read:user', 'notifications'],
    actScopes: [],
    actEnabled: false,
    agentIds: [defaultConnectorAgentId(ACCOUNT_ID)],
    createdAt: '2026-10-01T00:00:00+00:00',
    updatedAt: '2026-10-02T00:00:00+00:00',
    ...overrides,
  };
}

const readIds = (id: Parameters<typeof connectorDefinition>[0]) => connectorDefinition(id).readScopes.map((scope) => scope.id);
const actIds = (id: Parameters<typeof connectorDefinition>[0]) => connectorDefinition(id).actScopes.map((scope) => scope.id);

test('summaries map to panel states', () => {
  const connected = connectorStateFromSummary('github', summary());
  assert.equal(connected.status, 'connected');
  assert.deepEqual(connected.grantedScopeIds, readIds('github'));
  assert.equal(connected.actEnabled, false);
  assert.equal(connected.connectedAt, '2026-10-01T00:00:00+00:00');
  assert.deepEqual(connected.agentIds, ['cloud-agent:acct-1']);

  const acting = connectorStateFromSummary('gmail', summary({
    provider: 'gmail',
    readScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    actScopes: ['https://www.googleapis.com/auth/gmail.send'],
    actEnabled: true,
  }));
  assert.deepEqual(acting.grantedScopeIds, [...readIds('gmail'), ...actIds('gmail')]);
  assert.equal(acting.actEnabled, true);

  assert.equal(connectorStateFromSummary('slack', summary({ provider: 'slack', status: 'needs_reauth' })).status, 'needs_reauth');
  const revoked = connectorStateFromSummary('github', summary({ status: 'revoked' }));
  assert.equal(revoked.status, 'not_connected');
  assert.deepEqual(revoked.grantedScopeIds, []);
  assert.deepEqual(revoked.agentIds, []);
  assert.equal(connectorStateFromSummary('github', undefined).status, 'not_connected');
});

test('mapped states never carry token-like keys', () => {
  const states = connectorCatalog.map((definition) => connectorStateFromSummary(
    definition.providerId,
    summary({ provider: definition.providerId, actScopes: ['x'], actEnabled: true }),
  ));
  const keys: string[] = [];
  JSON.stringify(states, (key, value) => {
    if (key) keys.push(key);
    return value;
  });
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((key) => /token|secret/i.test(key)), []);
});

test('callback fragments parse a grant result or an error', () => {
  const result = { connectorId: 'conn-1', provider: 'gmail', grant: 'act', status: 'connected' };
  assert.deepEqual(parseConnectorCallbackFragment(`#kordi_connector=${base64UrlJson(result)}`), { kind: 'completed', result });
  assert.deepEqual(
    parseConnectorCallbackFragment(`http://127.0.0.1:5555/oauth/req#kordi_connector=${base64UrlJson(result)}`),
    { kind: 'completed', result },
  );
  assert.deepEqual(
    parseConnectorCallbackFragment('#kordi_connector_error=Access%20was%20not%20granted.&kordi_connector_error_code=provider_denied'),
    { kind: 'error', message: 'Access was not granted.', code: 'provider_denied' },
  );
  assert.deepEqual(
    parseConnectorCallbackFragment('#kordi_connector_error=Missing%20OAuth%20code.'),
    { kind: 'error', message: 'Missing OAuth code.', code: null },
  );
  assert.equal(parseConnectorCallbackFragment(''), null);
  assert.equal(parseConnectorCallbackFragment('#other=1'), null);
  assert.equal(parseConnectorCallbackFragment(null), null);
  assert.equal(parseConnectorCallbackFragment(`#kordi_connector=${base64UrlJson({ provider: 'gmail' })}`)?.kind, 'error');
});

test('audit entries map agent names and outcomes', () => {
  const agents = [
    { agentId: 'cloud-agent:acct-1', name: 'My Kordi', isDefault: true },
    { agentId: 'agent-research', name: 'Research', isDefault: false },
  ];
  const entry: CloudConnectorAuditEntry = {
    auditId: 'audit-1',
    connectorId: 'conn-github',
    agentId: 'agent-research',
    tool: 'github.list_notifications',
    toolGroup: 'read',
    outcome: 'completed',
    summary: 'Read 3 notifications.',
    createdAt: '2026-10-03T00:00:00+00:00',
  };
  assert.deepEqual(connectorAuditEntryFromCloud('github', entry, agents), {
    id: 'audit-1',
    providerId: 'github',
    at: '2026-10-03T00:00:00+00:00',
    agentName: 'Research',
    tool: 'github.list_notifications',
    group: 'read',
    outcome: 'completed',
    summary: 'Read 3 notifications.',
  });
  const ownerAction = connectorAuditEntryFromCloud('github', { ...entry, agentId: undefined, toolGroup: 'act', outcome: 'failed' }, agents);
  assert.equal(ownerAction.agentName, 'You');
  assert.equal(ownerAction.group, 'act');
  assert.equal(ownerAction.outcome, 'failed');
  assert.equal(connectorAuditEntryFromCloud('github', { ...entry, outcome: 'blocked_background' }, agents).outcome, 'blocked_background');
  assert.equal(connectorAuditEntryFromCloud('github', { ...entry, agentId: 'gone' }, agents).agentName, 'Agent');
});

test('the gate picks the cloud client, the preview client, or nothing', async () => {
  const http = new CloudConnectorsHttpClient({ baseUrl: 'http://srv', fetchImpl: recordingFetch(() => jsonResponse(500, {})).fetchImpl });
  const base = { accountId: ACCOUNT_ID, http, desktopShell: false };
  assert.equal(connectorsClientForAccount({ ...base, capabilities: { connectorsVersion: 1 } })?.source, 'cloud');
  assert.equal(connectorsClientForAccount({ ...base, capabilities: { connectorsVersion: 1 }, previewFlag: '1' })?.source, 'cloud');
  assert.equal(connectorsClientForAccount({ ...base, capabilities: {}, previewFlag: '1' })?.source, 'preview');
  assert.equal(connectorsClientForAccount({ ...base, capabilities: null, previewFlag: '1' })?.source, 'preview');
  assert.equal(connectorsClientForAccount({ ...base, capabilities: { connectorsVersion: null } }), null);
  assert.equal(connectorsClientForAccount({ ...base, capabilities: undefined, previewFlag: '0' }), null);

  const macLocal: MacLocalConnectorsState = {
    calendar: { enabled: true, permission: 'granted' },
    contacts: { enabled: false, permission: 'not_determined' },
    notification_center: { enabled: false, permission: 'not_determined' },
  };
  const invoke: DesktopInvoke = async <T,>() => macLocal as T;
  const desktop = connectorsClientForAccount({ ...base, desktopShell: true, invoke, capabilities: {}, previewFlag: '1' });
  assert.equal(desktop?.source, 'preview');
  assert.ok(desktop);
  const listed = await desktop.client.list();
  assert.equal(listed.states.find((state) => state.providerId === 'mac_calendar')?.status, 'connected');
});

test('capabilities load once per API origin and expose connectorsVersion', async () => {
  clearCloudAuthCapabilitiesCacheForTests();
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, { password: true, oauthProviders: [], connectorsVersion: 1 }));
  const first = new CloudAuthClient({ baseUrl: 'http://caps', fetchImpl });
  const second = new CloudAuthClient({ baseUrl: 'http://caps', fetchImpl });
  assert.equal((await loadCloudAuthCapabilities(first, 'http://caps')).connectorsVersion, 1);
  assert.equal((await loadCloudAuthCapabilities(second, 'http://caps')).connectorsVersion, 1);
  assert.equal(calls.length, 1);
  await loadCloudAuthCapabilities(second);
  assert.equal(calls.length, 2, 'clients without a shared key are cached per instance');
  clearCloudAuthCapabilitiesCacheForTests();
});

function cloudFixture(handler?: (call: FetchCall) => Response | undefined) {
  let connectors: CloudConnectorSummary[] = [summary()];
  const recorded = recordingFetch((call) => {
    const custom = handler?.(call);
    if (custom) return custom;
    const path = call.url.replace('http://srv', '');
    const method = call.init?.method ?? 'GET';
    if (path === '/v1/cloud/connectors' && method === 'GET') return jsonResponse(200, { connectors });
    if (path === '/v1/cloud/agents' && method === 'GET') return jsonResponse(200, { agents: [] });
    if (path === '/v1/cloud/connectors/conn-github' && method === 'DELETE') {
      connectors = [];
      return jsonResponse(200, { deletedEvents: 4 });
    }
    if (path === '/v1/cloud/connectors/conn-github/act' && method === 'POST') {
      return jsonResponse(409, { errorCode: 'act_not_granted', message: 'Grant act access for this connector before turning it on.' });
    }
    if (path === '/v1/cloud/connectors/conn-github/agents' && method === 'PUT') {
      const body = JSON.parse(String(call.init?.body)) as { agentIds: string[] };
      connectors = [summary({ agentIds: body.agentIds })];
      return jsonResponse(200, { connector: connectors[0] });
    }
    if (path.startsWith('/v1/cloud/connectors/conn-github/audit') && method === 'GET') {
      return jsonResponse(200, {
        entries: [{
          auditId: 'audit-1', connectorId: 'conn-github', tool: 'connector.act_on', toolGroup: 'act',
          outcome: 'completed', summary: 'Turned on acting through this connector.', createdAt: '2026-10-03T00:00:00+00:00',
        }],
      });
    }
    if (path === '/v1/cloud/connectors/gmail/oauth/start' && method === 'POST') {
      return jsonResponse(200, { authUrl: 'https://accounts.example/authorize?state=s1' });
    }
    return jsonResponse(404, { message: 'Not Found' });
  });
  const http = new CloudConnectorsHttpClient({ baseUrl: 'http://srv', fetchImpl: recorded.fetchImpl });
  return {
    ...recorded,
    http,
    setConnectors(next: CloudConnectorSummary[]) { connectors = next; },
  };
}

test('list and disconnect send the bearer token to the connector routes', async () => {
  const fixture = cloudFixture();
  const client = createCloudConnectorsClient({
    accountId: ACCOUNT_ID,
    http: fixture.http,
    defaultAgentName: 'Ada Agent',
    loadToken: async () => TOKEN,
  });

  const listed = await client.list();
  assert.equal(listed.states.length, connectorCatalog.length);
  assert.equal(listed.states.find((state) => state.providerId === 'github')?.status, 'connected');
  assert.equal(listed.states.find((state) => state.providerId === 'gmail')?.status, 'not_connected');
  assert.deepEqual(listed.agents, [{ agentId: 'cloud-agent:acct-1', name: 'Ada Agent', isDefault: true }]);

  await client.disconnect('github');
  const paths = fixture.calls.map((call) => `${call.init?.method ?? 'GET'} ${call.url}`);
  assert.deepEqual(paths, [
    'GET http://srv/v1/cloud/connectors',
    'GET http://srv/v1/cloud/agents',
    'DELETE http://srv/v1/cloud/connectors/conn-github',
  ]);
  for (const call of fixture.calls) assert.equal(header(call.init, 'authorization'), `Bearer ${TOKEN}`);

  const after = await client.list();
  assert.equal(after.states.find((state) => state.providerId === 'github')?.status, 'not_connected');
  assert.deepEqual(await client.auditLog('github'), []);
});

test('agent grants, act, and audit use the connector id', async () => {
  const fixture = cloudFixture();
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN });
  await client.list();

  const granted = await client.setAgentGrant('github', 'agent-research', true);
  assert.deepEqual(granted.agentIds, ['cloud-agent:acct-1', 'agent-research']);
  const put = fixture.calls.find((call) => call.init?.method === 'PUT');
  assert.equal(put?.url, 'http://srv/v1/cloud/connectors/conn-github/agents');
  assert.deepEqual(JSON.parse(String(put?.init?.body)), { agentIds: ['cloud-agent:acct-1', 'agent-research'] });

  await assert.rejects(client.setActEnabled('github', true), /Grant act access/);

  const audit = await client.auditLog('github');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].agentName, 'You');
  assert.ok(fixture.calls.some((call) => call.url === 'http://srv/v1/cloud/connectors/conn-github/audit?limit=50'));

  await assert.rejects(client.setActEnabled('gmail', true), /not connected/);
});

function fakeHandoff(fragment: string | Promise<string>) {
  const opened: string[] = [];
  let cancelled = 0;
  const handoff: ConnectorOAuthHandoff = {
    async prepare() {
      return {
        redirectUrl: 'http://127.0.0.1:5555/oauth/req-1',
        wait: () => Promise.resolve(fragment),
        cancel: async () => { cancelled += 1; },
      };
    },
    async open(url) { opened.push(url); },
  };
  return { handoff, opened, cancelled: () => cancelled };
}

test('connect starts OAuth with the loopback redirect and re-lists on success', async () => {
  const fixture = cloudFixture();
  const result = { connectorId: 'conn-gmail', provider: 'gmail', grant: 'read', status: 'connected' };
  const { handoff, opened, cancelled } = fakeHandoff(`#kordi_connector=${base64UrlJson(result)}`);
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN, oauth: handoff });
  fixture.setConnectors([summary(), summary({
    connectorId: 'conn-gmail',
    provider: 'gmail',
    readScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  })]);

  const state = await client.connect('gmail', { scopeIds: [] });
  assert.equal(state.status, 'connected');
  assert.deepEqual(state.grantedScopeIds, readIds('gmail'));
  assert.deepEqual(opened, ['https://accounts.example/authorize?state=s1']);
  assert.equal(cancelled(), 1);
  const start = fixture.calls.find((call) => call.url.endsWith('/oauth/start'));
  assert.equal(header(start?.init, 'authorization'), `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(start?.init?.body)), { grant: 'read', redirectAfter: 'http://127.0.0.1:5555/oauth/req-1' });
});

test('connect reports the callback error and times out after the limit', async () => {
  const fixture = cloudFixture();
  const denied = fakeHandoff('#kordi_connector_error=Access%20was%20not%20granted.&kordi_connector_error_code=provider_denied');
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN, oauth: denied.handoff });
  await assert.rejects(client.grantAct('gmail'), /Access was not granted\./);
  const start = fixture.calls.find((call) => call.url.endsWith('/oauth/start'));
  assert.equal(JSON.parse(String(start?.init?.body)).grant, 'act');

  const stalled = fakeHandoff(new Promise<string>(() => {}));
  const slow = createCloudConnectorsClient({
    accountId: ACCOUNT_ID,
    http: fixture.http,
    loadToken: async () => TOKEN,
    oauth: stalled.handoff,
    oauthTimeoutMs: 10,
  });
  await assert.rejects(slow.connect('gmail', { scopeIds: [] }), /Connecting Gmail timed out after 10 minutes/);
  assert.equal(stalled.cancelled(), 1);
});

test('in the Tauri shell the gate always layers the Mac-local rows', async () => {
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(target, 'window', { configurable: true, writable: true, value: { __TAURI_INTERNALS__: {} } });
  __setSessionBackendForTests({ load: async () => null, save: async () => {}, clear: async () => {} });
  try {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(500, {}));
    const http = new CloudConnectorsHttpClient({ baseUrl: 'http://srv', fetchImpl });
    const macLocal: MacLocalConnectorsState = {
      calendar: { enabled: true, permission: 'granted' },
      contacts: { enabled: false, permission: 'not_determined' },
      notification_center: { enabled: false, permission: 'not_determined' },
    };
    const invoke: DesktopInvoke = async <T,>() => macLocal as T;
    const base = { accountId: ACCOUNT_ID, http, invoke };

    const cloud = connectorsClientForAccount({ ...base, capabilities: { connectorsVersion: 1 } });
    assert.equal(cloud?.source, 'cloud');
    await assert.rejects(cloud!.client.grantAct('mac_calendar'), /not available yet/);
    // Service calls reach the cloud client, which needs the signed-in session.
    await assert.rejects(cloud!.client.connect('github', { scopeIds: [] }), /session is unavailable/);

    const bare = connectorsClientForAccount({ ...base, capabilities: {}, previewFlag: '0' });
    assert.equal(bare?.source, 'mac_local');
    const listed = await bare!.client.list();
    assert.equal(listed.states.length, connectorCatalog.length);
    assert.equal(listed.states.find((state) => state.providerId === 'mac_calendar')?.status, 'connected');
    assert.equal(listed.states.find((state) => state.providerId === 'github')?.status, 'not_connected');
    await assert.rejects(bare!.client.connect('github', { scopeIds: [] }), new RegExp(SERVICE_CONNECTORS_NEED_NEWER_SERVER.replace('.', '\\.')));
    await assert.rejects(bare!.client.grantAct('gmail'), /need a newer Kordi server/);
    assert.equal(calls.length, 0, 'the Mac-local-only base never calls the server');

    const preview = connectorsClientForAccount({ ...base, capabilities: null, previewFlag: '1' });
    assert.equal(preview?.source, 'preview');
    const previewListed = await preview!.client.list();
    assert.equal(previewListed.states.find((state) => state.providerId === 'github')?.status, 'connected');
    assert.equal(previewListed.states.find((state) => state.providerId === 'mac_contacts')?.status, 'not_connected');

    assert.equal(connectorsClientForAccount({ ...base, capabilities: {}, previewFlag: '0', desktopShell: false }), null);
  } finally {
    __setSessionBackendForTests(null);
    if (previousWindow) Object.defineProperty(target, 'window', previousWindow);
    else delete target.window;
  }
});

// Connectors client behavior against servers with PR #1726 and the OAuth
// completion step: catalog scope ids, agent filtering, gone connectors,
// cancellation, polling, and the capability states of the gate.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudAuthClient } from '../src/features/cloud/authClient';
import {
  clearCloudAuthCapabilitiesCacheForTests,
  loadCloudAuthCapabilities,
} from '../src/features/cloud/cloudAuthCapabilities';
import {
  CloudConnectorsHttpClient,
  parseConnectorCallbackFragment,
  type CloudConnectorSummary,
} from '../src/features/cloud/cloudConnectorsClient';
import type { DesktopInvoke, MacLocalConnectorsState } from '../src/features/connectors/connectorsClient';
import {
  connectorsClientForAccount,
  KORDI_CLOUD_UNREACHABLE,
} from '../src/features/connectors/connectorsClientSelection';
import {
  connectorStateFromSummary,
  createCloudConnectorsClient,
} from '../src/features/connectors/connectorsCloudClient';
import { isConnectorFlowCanceled, isConnectorGone } from '../src/features/connectors/connectorsErrors';
import {
  ACCOUNT_ID,
  actIds,
  agents1726,
  base64UrlJson,
  cloudFixture,
  fakeHandoff,
  gmailSummary,
  header,
  jsonResponse,
  pollingHandoff,
  readIds,
  recordingFetch,
  summary,
  summary1726,
  TOKEN,
} from './helpers/cloudConnectorsFixtures';

test('server scope ids and last event time win over the coarse mapping', () => {
  const state = connectorStateFromSummary('github', summary1726());
  assert.deepEqual(state.grantedScopeIds, ['github.notifications.read'], 'a partial grant stays partial');
  assert.equal(state.lastEventAt, '2026-10-04T08:00:00+00:00');
  const none = connectorStateFromSummary('github', summary1726({ grantedScopeIds: [], lastEventAt: null }));
  assert.deepEqual(none.grantedScopeIds, []);
  assert.equal(none.lastEventAt, null);
  assert.deepEqual(connectorStateFromSummary('github', summary()).grantedScopeIds, readIds('github'), 'older servers fall back');
  assert.equal(connectorStateFromSummary('github', summary()).lastEventAt, null);
});

test('a #1726 list response supplies agents, scopes, and failed audit outcomes', async () => {
  const fixture = cloudFixture((call) => {
    const path = call.url.replace('http://srv', '');
    if (path === '/v1/cloud/connectors') return jsonResponse(200, { connectors: [summary1726()], agents: agents1726 });
    if (path.startsWith('/v1/cloud/connectors/conn-github/audit')) {
      return jsonResponse(200, {
        entries: [{
          auditId: 'audit-9', connectorId: 'conn-github', agentId: 'agent-research', tool: 'github.list_notifications',
          toolGroup: 'read', outcome: 'failed', summary: 'The provider request failed.', createdAt: '2026-10-04T00:00:00+00:00',
        }],
      });
    }
    return undefined;
  });
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN });
  const listed = await client.list();
  assert.deepEqual(listed.agents, agents1726);
  assert.ok(!fixture.calls.some((call) => call.url.endsWith('/v1/cloud/agents')), 'listed agents skip /v1/cloud/agents');
  const github = listed.states.find((state) => state.providerId === 'github');
  assert.deepEqual(github?.grantedScopeIds, ['github.notifications.read']);
  assert.equal(github?.lastEventAt, '2026-10-04T08:00:00+00:00');
  const [entry] = await client.auditLog('github');
  assert.equal(entry.outcome, 'failed');
  assert.equal(entry.agentName, 'Research');
});

test('agent grants drop ids for agents that no longer exist', async () => {
  let connectors = [summary1726({ agentIds: ['cloud-agent:acct-1', 'agent-archived'] })];
  const fixture = cloudFixture((call) => {
    const path = call.url.replace('http://srv', '');
    if (path === '/v1/cloud/connectors') return jsonResponse(200, { connectors, agents: agents1726 });
    if (path === '/v1/cloud/connectors/conn-github/agents') {
      const body = JSON.parse(String(call.init?.body)) as { agentIds: string[] };
      if (body.agentIds.includes('agent-archived')) return jsonResponse(400, { errorCode: 'unknown_agent', message: 'Unknown agent.' });
      connectors = [summary1726({ agentIds: body.agentIds })];
      return jsonResponse(200, { connector: connectors[0] });
    }
    return undefined;
  });
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN });
  await client.list();
  const granted = await client.setAgentGrant('github', 'agent-research', true);
  assert.deepEqual(granted.agentIds, ['cloud-agent:acct-1', 'agent-research']);
  const revoked = await client.setAgentGrant('github', 'cloud-agent:acct-1', false);
  assert.deepEqual(revoked.agentIds, ['agent-research']);
});

test('a connector the server no longer has is cleared and re-listed', async () => {
  for (const action of ['act', 'agents', 'audit', 'delete'] as const) {
    let listCalls = 0;
    const fixture = cloudFixture((call) => {
      const path = call.url.replace('http://srv', '');
      if (path === '/v1/cloud/connectors') {
        listCalls += 1;
        return jsonResponse(200, { connectors: listCalls === 1 ? [summary1726()] : [], agents: agents1726 });
      }
      if (path.startsWith('/v1/cloud/connectors/conn-github')) {
        return jsonResponse(404, { errorCode: 'connector_not_found', message: 'Not Found' });
      }
      return undefined;
    });
    const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN });
    await client.list();
    const run = action === 'act' ? client.setActEnabled('github', false)
      : action === 'agents' ? client.setAgentGrant('github', 'agent-research', true)
        : action === 'audit' ? client.auditLog('github')
          : client.disconnect('github');
    await assert.rejects(run, (error: unknown) => {
      assert.ok(isConnectorGone(error), action);
      assert.equal((error as Error).message, 'GitHub is no longer connected.');
      return true;
    });
    assert.equal(listCalls, 2, `${action} re-lists`);
    const after = await client.recheckPermission('github');
    assert.equal(after.status, 'not_connected');
  }
});

test('callback fragments carry a completion code from newer servers', () => {
  const pending = { completionCode: 'cc-1', provider: 'gmail', grant: 'read', status: 'pending' };
  assert.deepEqual(parseConnectorCallbackFragment(`#kordi_connector=${base64UrlJson(pending)}`), {
    kind: 'pending',
    result: { completionCode: 'cc-1', provider: 'gmail', grant: 'read' },
  });
});

test('connect finishes the grant with the completion code before re-listing', async () => {
  let connectors: CloudConnectorSummary[] = [];
  const fixture = cloudFixture((call) => {
    const path = call.url.replace('http://srv', '');
    if (path === '/v1/cloud/connectors') return jsonResponse(200, { connectors, agents: agents1726 });
    if (path === '/v1/cloud/connectors/oauth/complete') {
      connectors = [gmailSummary()];
      return jsonResponse(200, { connector: connectors[0] });
    }
    return undefined;
  });
  const fragment = `#kordi_connector=${base64UrlJson({ completionCode: 'cc-1', provider: 'gmail', grant: 'read', status: 'pending' })}`;
  const { handoff, cancelled } = fakeHandoff(fragment);
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN, oauth: handoff });
  const state = await client.connect('gmail', { scopeIds: [] });
  assert.equal(state.status, 'connected');
  assert.deepEqual(state.grantedScopeIds, readIds('gmail'));
  const complete = fixture.calls.find((call) => call.url === 'http://srv/v1/cloud/connectors/oauth/complete');
  assert.equal(complete?.init?.method, 'POST');
  assert.equal(header(complete?.init, 'authorization'), `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(String(complete?.init?.body)), { completionCode: 'cc-1' });
  const order = fixture.calls.map((call) => call.url.replace('http://srv', ''));
  assert.ok(order.lastIndexOf('/v1/cloud/connectors') > order.indexOf('/v1/cloud/connectors/oauth/complete'), 're-lists after completing');
  assert.equal(cancelled(), 1);
});

test('a read grant that does not end connected is rejected', async () => {
  const fixture = cloudFixture((call) => {
    const path = call.url.replace('http://srv', '');
    if (path === '/v1/cloud/connectors') return jsonResponse(200, { connectors: [gmailSummary({ status: 'needs_reauth' })], agents: agents1726 });
    if (path === '/v1/cloud/connectors/oauth/complete') return jsonResponse(200, { connector: gmailSummary({ status: 'needs_reauth' }) });
    return undefined;
  });
  const fragment = `#kordi_connector=${base64UrlJson({ completionCode: 'cc-2', provider: 'gmail', grant: 'read', status: 'pending' })}`;
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN, oauth: fakeHandoff(fragment).handoff });
  await assert.rejects(client.connect('gmail', { scopeIds: [] }), /Gmail did not finish connecting/);
});

test('an act grant without the act scopes is rejected', async () => {
  // The provider answered the act request with read scopes only, so no catalog act scope is granted.
  const partial = gmailSummary({ actScopes: [], grantedScopeIds: [...readIds('gmail')], actEnabled: false });
  const fixture = cloudFixture((call) => {
    const path = call.url.replace('http://srv', '');
    if (path === '/v1/cloud/connectors') return jsonResponse(200, { connectors: [partial], agents: agents1726 });
    return undefined;
  });
  const fragment = `#kordi_connector=${base64UrlJson({ connectorId: 'conn-gmail', provider: 'gmail', grant: 'act', status: 'connected' })}`;
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN, oauth: fakeHandoff(fragment).handoff });
  await assert.rejects(client.grantAct('gmail'), /^Error: Gmail did not grant act access\.$/);

  const full = { ...partial, grantedScopeIds: [...readIds('gmail'), ...actIds('gmail')] };
  const ok = cloudFixture((call) => (call.url === 'http://srv/v1/cloud/connectors' ? jsonResponse(200, { connectors: [full], agents: agents1726 }) : undefined));
  const granted = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: ok.http, loadToken: async () => TOKEN, oauth: fakeHandoff(fragment).handoff });
  const state = await granted.grantAct('gmail');
  assert.equal(state.actEnabled, true);
});

test('aborting connect cancels the loopback and rejects as canceled', async () => {
  const fixture = cloudFixture();
  const stalled = fakeHandoff(new Promise<string>(() => {}));
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN, oauth: stalled.handoff });
  const controller = new AbortController();
  const pending = client.connect('gmail', { scopeIds: [], signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(isConnectorFlowCanceled(error));
    assert.match((error as Error).message, /canceled/);
    return true;
  });
  assert.ok(stalled.cancelled() >= 1, 'the loopback listener is canceled');

  const already = new AbortController();
  already.abort();
  await assert.rejects(client.grantAct('gmail', { signal: already.signal }), /canceled/);
});

test('a blocked pop-up fails at once outside the desktop shell', async () => {
  const fixture = cloudFixture();
  const client = createCloudConnectorsClient({ accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN, oauth: pollingHandoff(false) });
  await assert.rejects(client.connect('gmail', { scopeIds: [] }), /^Error: Allow pop-ups for Kordi to connect Gmail\.$/);
  assert.equal(fixture.calls.filter((call) => call.url === 'http://srv/v1/cloud/connectors').length, 0, 'no polling');
});

test('polling tolerates transient list failures and respects abort', async () => {
  let listCalls = 0;
  const fixture = cloudFixture((call) => {
    if (call.url !== 'http://srv/v1/cloud/connectors') return undefined;
    listCalls += 1;
    if (listCalls <= 3) return jsonResponse(503, { message: 'Unavailable' });
    return jsonResponse(200, { connectors: [gmailSummary()], agents: agents1726 });
  });
  const client = createCloudConnectorsClient({
    accountId: ACCOUNT_ID, http: fixture.http, loadToken: async () => TOKEN, oauth: pollingHandoff(true), pollIntervalMs: 1,
  });
  assert.equal((await client.connect('gmail', { scopeIds: [] })).status, 'connected');

  let failing = 0;
  const down = cloudFixture((call) => {
    if (call.url !== 'http://srv/v1/cloud/connectors') return undefined;
    failing += 1;
    return jsonResponse(503, { message: 'Still unavailable.' });
  });
  const failingClient = createCloudConnectorsClient({
    accountId: ACCOUNT_ID, http: down.http, loadToken: async () => TOKEN, oauth: pollingHandoff(true), pollIntervalMs: 1,
  });
  await assert.rejects(failingClient.connect('gmail', { scopeIds: [] }), /Still unavailable/);
  assert.equal(failing, 4, 'three retries, then the fourth failure is reported');

  const idle = cloudFixture((call) => (call.url === 'http://srv/v1/cloud/connectors' ? jsonResponse(200, { connectors: [] }) : undefined));
  const waiting = createCloudConnectorsClient({
    accountId: ACCOUNT_ID, http: idle.http, loadToken: async () => TOKEN, oauth: pollingHandoff(true), pollIntervalMs: 1,
  });
  const controller = new AbortController();
  const pending = waiting.connect('gmail', { scopeIds: [], signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, /canceled/);
});

test('the gate tells loading and failed capabilities apart from an older server', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(500, {}));
  const http = new CloudConnectorsHttpClient({ baseUrl: 'http://srv', fetchImpl });
  const macLocal: MacLocalConnectorsState = {
    calendar: { enabled: true, permission: 'granted' },
    contacts: { enabled: false, permission: 'not_determined' },
    notification_center: { enabled: false, permission: 'not_determined' },
  };
  const invoke: DesktopInvoke = async <T,>() => macLocal as T;
  const base = { accountId: ACCOUNT_ID, http, invoke, desktopShell: true, previewFlag: '0' };

  const loading = connectorsClientForAccount({ ...base, capabilities: null, capabilitiesStatus: 'loading' });
  assert.equal(loading?.servicesStatus, 'checking');
  assert.equal((await loading!.client.list()).states.find((state) => state.providerId === 'mac_calendar')?.status, 'connected');
  await assert.rejects(loading!.client.connect('github', { scopeIds: [] }), /Checking Kordi Cloud/);

  const failed = connectorsClientForAccount({ ...base, capabilities: null, capabilitiesStatus: 'failed' });
  assert.equal(failed?.servicesStatus, 'unreachable');
  await assert.rejects(failed!.client.connect('github', { scopeIds: [] }), new RegExp(KORDI_CLOUD_UNREACHABLE.replace('.', '\\.')));

  const old = connectorsClientForAccount({ ...base, capabilities: {}, capabilitiesStatus: 'loaded' });
  assert.equal(old?.servicesStatus, 'unsupported');
  await assert.rejects(old!.client.connect('github', { scopeIds: [] }), /need a newer Kordi server/);

  const stale = connectorsClientForAccount({ ...base, capabilities: { connectorsVersion: 1 }, capabilitiesStatus: 'failed' });
  assert.equal(stale?.source, 'mac_local', 'only a loaded response selects the cloud client');

  const ready = connectorsClientForAccount({ ...base, capabilities: { connectorsVersion: 1 }, capabilitiesStatus: 'loaded' });
  assert.equal(ready?.source, 'cloud');
  assert.equal(ready?.servicesStatus, 'ready');

  assert.equal(connectorsClientForAccount({ ...base, desktopShell: false, capabilities: null, capabilitiesStatus: 'failed' }), null);
  assert.equal(calls.length, 0);
});

test('a failed capabilities fetch is not cached, so a refetch reaches the server', async () => {
  clearCloudAuthCapabilitiesCacheForTests();
  let attempts = 0;
  const { calls, fetchImpl } = recordingFetch(() => {
    attempts += 1;
    return attempts === 1 ? jsonResponse(503, { message: 'down' }) : jsonResponse(200, { password: true, oauthProviders: [], connectorsVersion: 1 });
  });
  const client = new CloudAuthClient({ baseUrl: 'http://caps-retry', fetchImpl });
  await assert.rejects(loadCloudAuthCapabilities(client, 'http://caps-retry'));
  assert.equal((await loadCloudAuthCapabilities(client, 'http://caps-retry')).connectorsVersion, 1);
  assert.equal(calls.length, 2);
  await loadCloudAuthCapabilities(client, 'http://caps-retry');
  assert.equal(calls.length, 2, 'a success is cached');
  clearCloudAuthCapabilitiesCacheForTests();
});

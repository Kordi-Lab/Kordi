// Shared fixtures for the cloud connectors client tests.

import { CloudConnectorsHttpClient, type CloudConnectorSummary } from '../../src/features/cloud/cloudConnectorsClient';
import { defaultConnectorAgentId, type ConnectorOAuthHandoff } from '../../src/features/connectors/connectorsCloudClient';
import { connectorDefinition } from '../../src/features/connectors/connectorsModel';

export type FetchCall = { url: string; init: RequestInit | undefined };

export function recordingFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
  return { calls, fetchImpl };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers[name];
}

export function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export const ACCOUNT_ID = 'acct-1';
export const TOKEN = 'session-abc';

export function summary(overrides: Partial<CloudConnectorSummary> = {}): CloudConnectorSummary {
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

export const readIds = (id: Parameters<typeof connectorDefinition>[0]) => connectorDefinition(id).readScopes.map((scope) => scope.id);
export const actIds = (id: Parameters<typeof connectorDefinition>[0]) => connectorDefinition(id).actScopes.map((scope) => scope.id);

export function cloudFixture(handler?: (call: FetchCall) => Response | undefined) {
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

export function fakeHandoff(fragment: string | Promise<string>) {
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

// Shapes sent by servers with PR #1726: catalog scope ids, last event time,
// and the agents list inside the connectors response.
export function summary1726(overrides: Partial<CloudConnectorSummary> = {}): CloudConnectorSummary {
  return summary({
    grantedScopeIds: ['github.notifications.read'],
    lastEventAt: '2026-10-04T08:00:00+00:00',
    ...overrides,
  });
}

export const agents1726 = [
  { agentId: 'cloud-agent:acct-1', name: 'My Kordi', isDefault: true },
  { agentId: 'agent-research', name: 'Research', isDefault: false },
];

export function gmailSummary(overrides: Partial<CloudConnectorSummary> = {}): CloudConnectorSummary {
  return summary1726({
    connectorId: 'conn-gmail',
    provider: 'gmail',
    readScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    grantedScopeIds: readIds('gmail'),
    ...overrides,
  });
}

export function pollingHandoff(opened: boolean) {
  const handoff: ConnectorOAuthHandoff = {
    async prepare() { return null; },
    async open() { return opened; },
  };
  return handoff;
}

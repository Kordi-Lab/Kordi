import type {
  CloudProviderAuthSnapshot,
  CloudProviderRouteTestInput,
  CloudProviderRouteTestResult,
} from './cloudAgentRuntimeTypes';
import { defaultCloudAuthClient } from './authClient';
import { CloudAuthError } from './cloudAuthError';
import { isOmpUnavailableResponse, OmpUnavailableError } from './ompAvailability';
import type { OmpLoginSpec } from './providerLogin';

// Hosted OMP provider accounts: the catalog, hosted snapshots, key checks and
// route tests. Kept apart from the general Cloud client so it can grow with
// the OMP transfer without touching unrelated account code.

export type OmpProviderCatalogResponse = {
  version?: string | null;
  providers: Array<{
    id: string;
    name?: string | null;
    models: string[];
    defaultModel?: string | null;
    auth?: {
      kind: 'api-key' | 'oauth-code' | 'device-code' | 'custom' | 'native';
      name: string;
      acceptsApiKey: boolean;
      instructions: string | null;
      authUrl: string | null;
      placeholder: string | null;
      envVars: string[];
    };
    login?: OmpLoginSpec | null;
  }>;
};

type CloudRequest = <T>(path: string, init: RequestInit, fallbackMessage: string) => Promise<T>;

export type CloudProviderAuthApi = ReturnType<typeof createCloudProviderAuthApi>;

/** Uses the Cloud client's transport, so tests and callers can inject one client. */
export function createCloudProviderAuthApi(client: { request: CloudRequest } = defaultCloudAuthClient()) {
  const send: CloudRequest = (path, init, fallbackMessage) => client.request(path, init, fallbackMessage);
  // OMP routes that an older or OMP-less backend does not serve.
  const sendOmp: CloudRequest = async <T>(path: string, init: RequestInit, fallbackMessage: string) => {
    try {
      return await send<T>(path, init, fallbackMessage);
    } catch (caught) {
      if (caught instanceof CloudAuthError && isOmpUnavailableResponse(caught.status, caught.code)) throw new OmpUnavailableError();
      throw caught;
    }
  };
  const authorized = (token: string, json = false): HeadersInit => (
    json ? { 'content-type': 'application/json', authorization: `Bearer ${token}` } : { authorization: `Bearer ${token}` }
  );

  return {
    async listProviderAuthSnapshots(token: string, currentDeviceOnly = true): Promise<CloudProviderAuthSnapshot[]> {
      const response = await send<{ snapshots: CloudProviderAuthSnapshot[] }>(
        `/v1/cloud/agent-provider-auth/snapshots?currentDeviceOnly=${currentDeviceOnly}`,
        { method: 'GET', headers: authorized(token) },
        'Could not load Cloud provider-auth snapshots.',
      );
      return response.snapshots;
    },
    ompProviderCatalog(token?: string): Promise<OmpProviderCatalogResponse> {
      return sendOmp('/v1/cloud/agent-provider-auth/catalog', { method: 'GET', headers: token ? authorized(token) : {} }, 'Could not load OMP providers.');
    },
    validateOmpProviderKey(token: string, provider: string, apiKey: string): Promise<{ verified: boolean }> {
      return sendOmp(
        '/v1/cloud/agent-provider-auth/validate-key',
        { method: 'POST', headers: authorized(token, true), body: JSON.stringify({ provider, apiKey }) },
        'Could not verify this provider key.',
      );
    },
    testProviderRoute(token: string, input: CloudProviderRouteTestInput): Promise<CloudProviderRouteTestResult> {
      return sendOmp(
        '/v1/cloud/agent-provider-auth/test-route',
        { method: 'POST', headers: authorized(token, true), body: JSON.stringify(input) },
        'Could not test this provider route.',
      );
    },
  };
}

/** Shared fakes for the login-session tests. Every value is synthetic; nothing reaches the network. */
import type { OAuthController, OAuthCredentials } from '@oh-my-pi/pi-ai';
import { acceptsHostedApiKey, type ProviderLoginPolicy } from './login-policy';
import { LoginSessionManager, type LoginRegistry, type LoginSnapshot } from './login-sessions';
import { NO_ENDPOINT } from './provider-endpoint';

export type FakeLogin = (controller: OAuthController) => Promise<OAuthCredentials | string>;
export type FakeProvider = { policy: ProviderLoginPolicy; login?: FakeLogin };
export type FakeRegistry = LoginRegistry & { controllers: OAuthController[] };

export const SYNTHETIC_CREDENTIALS: OAuthCredentials = {
  access: 'synthetic-access-token',
  refresh: 'synthetic-refresh-token',
  expires: 1_900_000_000_000,
  email: 'user@example.test',
  accountId: 'synthetic-account',
};

/** A fake policy; `acceptsApiKeyMethod` follows the shared rule unless overridden. */
export function policy(overrides: Partial<ProviderLoginPolicy>): ProviderLoginPolicy {
  const merged: ProviderLoginPolicy = {
    kind: 'custom',
    name: 'Fake provider',
    instructions: null,
    prompt: null,
    placeholder: null,
    authUrl: null,
    validates: false,
    pasteKey: false,
    manualOnly: false,
    callbackPort: null,
    callbackPath: null,
    hook: null,
    apiKeyFormat: 'bearer',
    envVars: [],
    storeCredentialsAs: null,
    acceptsApiKeyMethod: false,
    ...overrides,
  };
  return { ...merged, acceptsApiKeyMethod: overrides.acceptsApiKeyMethod ?? acceptsHostedApiKey(merged, false) };
}

export function fakeRegistry(
  providers: Record<string, FakeProvider>,
  validateApiKey: LoginRegistry['validateApiKey'] = async (_provider, apiKey) => ({ apiKey: apiKey.trim() }),
): FakeRegistry {
  const controllers: OAuthController[] = [];
  return {
    controllers,
    policy: (id) => providers[id]?.policy,
    login: async (id, controller) => {
      controllers.push(controller);
      const login = providers[id]?.login;
      if (!login) throw new Error('missing fake login');
      return login(controller);
    },
    validateApiKey,
    endpoint: async () => NO_ENDPOINT,
  };
}

export function manager(registry: LoginRegistry, now?: () => number) {
  return new LoginSessionManager({ registry, now, firstStepWaitMs: 200 });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function until(
  sessions: LoginSessionManager,
  sessionId: string,
  predicate: (snapshot: LoginSnapshot) => boolean,
): Promise<LoginSnapshot> {
  let snapshot = await sessions.poll(sessionId, 0);
  const deadline = Date.now() + 5_000;
  while (!predicate(snapshot)) {
    if (Date.now() > deadline) throw new Error(`timed out in status ${snapshot.status}`);
    snapshot = await sessions.poll(sessionId, 0.5, snapshot.version);
  }
  return snapshot;
}

export const apiKeyProvider = () => policy({
  kind: 'api-key',
  name: 'Fake Key',
  instructions: 'Copy a key from the console',
  prompt: 'Paste your Fake key',
  placeholder: 'fk-...',
  authUrl: 'https://console.example.test/keys',
  validates: true,
});

export const promptLogin = (): FakeProvider => ({
  policy: policy({ name: 'Acme' }),
  login: async (controller) => {
    const token = await controller.onPrompt!({ message: 'Paste your access token', placeholder: 'tok-...', secret: true });
    return { ...SYNTHETIC_CREDENTIALS, access: token.trim() };
  },
});

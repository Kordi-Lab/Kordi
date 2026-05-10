// Cloud-edition auth HTTP client. Talks to bridges/cli's /v1/cloud/auth/* routes.
// Stays a pure TS module: no React, no Tauri imports — easy to test with a fetch stub.

const DEFAULT_BASE_URL = 'http://127.0.0.1:17080';

export type CloudAccount = {
  accountId: string;
  displayName: string | null;
  primaryEmail: string | null;
  avatarUrl: string | null;
  passwordSet: boolean;
};

export type CloudSession = {
  token: string;
  expiresAt: string;
};

export type CloudAuthResult = {
  account: CloudAccount;
  session: CloudSession;
};

export type CloudAuthErrorCode =
  | 'invalid_email'
  | 'weak_password'
  | 'email_in_use'
  | 'invalid_credentials'
  | 'invalid_session'
  | 'rate_limited'
  | 'account_missing'
  | 'invalid_account_id'
  | 'invalid_pubkey'
  | 'self_contact'
  | 'server_error'
  | 'network_error'
  | 'unknown';

export type CloudPublicProfile = {
  accountId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isContact: boolean;
  isSelf: boolean;
};

export type CloudContactSummary = {
  accountId: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
};

export type RegisterDeviceResult = {
  nodeId: string;
  apiKey: string;
};

export class CloudAuthError extends Error {
  readonly code: CloudAuthErrorCode;
  readonly status: number;

  constructor(code: CloudAuthErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'CloudAuthError';
  }
}

function readBaseUrl(env?: { VITE_KORDI_CLOUD_API_BASE?: string }): string {
  const fromEnv = env?.VITE_KORDI_CLOUD_API_BASE;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim().replace(/\/+$/, '');
  if (typeof import.meta !== 'undefined') {
    const meta = (import.meta as ImportMeta & { env?: { VITE_KORDI_CLOUD_API_BASE?: string } }).env;
    if (meta?.VITE_KORDI_CLOUD_API_BASE && meta.VITE_KORDI_CLOUD_API_BASE.trim().length > 0) {
      return meta.VITE_KORDI_CLOUD_API_BASE.trim().replace(/\/+$/, '');
    }
  }
  return DEFAULT_BASE_URL;
}

export type CloudAuthClientOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type ServerErrorBody = { errorCode?: string; message?: string };

function isErrorCode(value: unknown): value is CloudAuthErrorCode {
  return (
    value === 'invalid_email' ||
    value === 'weak_password' ||
    value === 'email_in_use' ||
    value === 'invalid_credentials' ||
    value === 'invalid_session' ||
    value === 'rate_limited' ||
    value === 'account_missing' ||
    value === 'invalid_account_id' ||
    value === 'invalid_pubkey' ||
    value === 'self_contact' ||
    value === 'server_error'
  );
}

async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildError(status: number, body: unknown, fallbackMessage: string): CloudAuthError {
  const data = (body as ServerErrorBody) ?? {};
  const code = isErrorCode(data.errorCode) ? data.errorCode : 'unknown';
  const message = typeof data.message === 'string' && data.message.length > 0
    ? data.message
    : fallbackMessage;
  return new CloudAuthError(code, message, status);
}

export class CloudAuthClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CloudAuthClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? readBaseUrl();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async send<TResponse>(
    path: string,
    init: RequestInit,
    fallbackMessage: string,
  ): Promise<TResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Network request failed.';
      throw new CloudAuthError('network_error', message, 0);
    }
    if (response.status === 204) {
      return undefined as TResponse;
    }
    const body = await readJsonSafe(response);
    if (!response.ok) {
      throw buildError(response.status, body, fallbackMessage);
    }
    return body as TResponse;
  }

  async signup(input: {
    email: string;
    password: string;
    displayName?: string;
    avatarSeed?: string;
  }): Promise<CloudAuthResult> {
    return this.send<CloudAuthResult>(
      '/v1/cloud/auth/signup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
      'Could not create account.',
    );
  }

  async login(input: { email: string; password: string }): Promise<CloudAuthResult> {
    return this.send<CloudAuthResult>(
      '/v1/cloud/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
      'Could not sign in.',
    );
  }

  async me(token: string): Promise<CloudAccount> {
    return this.send<CloudAccount>(
      '/v1/cloud/auth/me',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load account.',
    );
  }

  async logout(token: string): Promise<void> {
    await this.send<void>(
      '/v1/cloud/auth/logout',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not sign out.',
    );
  }

  async registerDevice(
    token: string,
    input: { ed25519Pubkey: string; x25519Pubkey: string; displayName?: string },
  ): Promise<RegisterDeviceResult> {
    return this.send<RegisterDeviceResult>(
      '/v1/cloud/auth/register-device',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
      'Could not register device on bridges.',
    );
  }

  async getProfile(token: string, accountId: string): Promise<CloudPublicProfile> {
    return this.send<CloudPublicProfile>(
      `/v1/cloud/accounts/${encodeURIComponent(accountId)}/profile`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load profile.',
    );
  }

  async addContact(token: string, peerAccountId: string): Promise<void> {
    await this.send<void>(
      '/v1/cloud/contacts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ peerAccountId }),
      },
      'Could not add contact.',
    );
  }

  async listContacts(token: string): Promise<CloudContactSummary[]> {
    const response = await this.send<{ contacts: CloudContactSummary[] }>(
      '/v1/cloud/contacts',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load contacts.',
    );
    return response?.contacts ?? [];
  }
}

// Convenience factory for production callers that don't need to inject deps.
export function defaultCloudAuthClient(): CloudAuthClient {
  return new CloudAuthClient();
}

import type {
  CloudAccount,
  CloudAuthCapabilities,
  CloudAuthResult,
  CloudOAuthProvider,
  CloudOAuthStartResponse,
  CloudProfileUpdateInput,
} from './authClient';
import { CloudAuthError } from './cloudAuthError';
import { isProductionCloudOrigin } from './cloudApiEnvironment';
import type { CloudDeviceRegistration } from './deviceIdentity';

type CloudIdentityRequest = <TResponse>(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
) => Promise<TResponse>;

export class CloudIdentityAuthClient {
  constructor(
    private readonly request: CloudIdentityRequest,
    private readonly baseUrl: string,
    private readonly deviceRegistration: () => Promise<CloudDeviceRegistration>,
  ) {}

  async signup(input: {
    email: string;
    password: string;
    displayName?: string;
    avatarUrl?: string;
  }): Promise<CloudAuthResult> {
    const device = await this.deviceRegistration();
    return this.request<CloudAuthResult>(
      '/v1/cloud/auth/signup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, device }),
      },
      'Could not create account.',
    );
  }

  async capabilities(): Promise<CloudAuthCapabilities> {
    try {
      return await this.request<CloudAuthCapabilities>(
        '/v1/cloud/auth/capabilities',
        { method: 'GET' },
        'Could not load available sign-in methods.',
      );
    } catch (caught) {
      // The hosted product API supported both OAuth start routes before it
      // exposed the capabilities endpoint. Keep those deployed versions
      // usable while the start route remains the authoritative config check.
      if (
        caught instanceof CloudAuthError
        && caught.status === 404
        && isProductionCloudOrigin(this.baseUrl)
      ) {
        return { password: true, oauthProviders: ['google', 'github'] };
      }
      throw caught;
    }
  }

  async login(input: { email: string; password: string }): Promise<CloudAuthResult> {
    const device = await this.deviceRegistration();
    return this.request<CloudAuthResult>(
      '/v1/cloud/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, device }),
      },
      'Could not sign in.',
    );
  }

  me(token: string): Promise<CloudAccount> {
    return this.request<CloudAccount>(
      '/v1/cloud/auth/me',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not load account.',
    );
  }

  async startOAuth(
    provider: CloudOAuthProvider,
    redirectAfter: string,
  ): Promise<CloudOAuthStartResponse> {
    const device = await this.deviceRegistration();
    const params = new URLSearchParams({
      redirectAfter,
      deviceName: device.displayName,
      devicePlatform: device.platform,
      deviceOsVersion: device.osVersion,
      deviceAppVersion: device.appVersion,
      deviceApproximateLocation: device.approximateLocation,
      devicePublicKey: device.publicKey,
      deviceKeyAlgorithm: device.keyAlgorithm,
    });
    return this.request<CloudOAuthStartResponse>(
      `/v1/cloud/auth/oauth/${encodeURIComponent(provider)}/start?${params.toString()}`,
      { method: 'GET' },
      'Could not start social sign-in.',
    );
  }

  updateProfile(token: string, input: CloudProfileUpdateInput): Promise<CloudAccount> {
    return this.request<CloudAccount>(
      '/v1/cloud/auth/me',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
      'Could not update profile.',
    );
  }

  async logout(token: string): Promise<void> {
    await this.request<void>(
      '/v1/cloud/auth/logout',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      },
      'Could not sign out.',
    );
  }
}

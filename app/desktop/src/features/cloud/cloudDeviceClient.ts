import {
  installationDeviceRegistration,
  type CloudDeviceRegistration,
} from './deviceIdentity';

export type CloudDeviceAuthorizationState = 'pending_review' | 'confirmed';

export type CloudDeviceAuthorization = {
  deviceId: string;
  displayName: string | null;
  platform: string | null;
  osVersion: string | null;
  appVersion: string | null;
  createdAt: string;
  lastActiveAt: string;
  authorizationState: CloudDeviceAuthorizationState;
  currentDevice: boolean;
  sessionExpiresAt: string | null;
  approximateLocation: string | null;
  syncStatus: {
    protocolVersion: number;
    lastAppliedSequence: number;
    lastSuccessfulCatchUpAt: string | null;
  };
};

export type CloudDeviceListResponse = { devices: CloudDeviceAuthorization[] };
export type CloudDeviceMutationResponse = { affectedDeviceIds: string[] };

type CloudDeviceRequest = <TResponse>(
  path: string,
  init: RequestInit,
  fallbackMessage: string,
) => Promise<TResponse>;

export class CloudDeviceClient {
  constructor(
    private readonly request: CloudDeviceRequest,
    private readonly deviceRegistration: () => Promise<CloudDeviceRegistration> = installationDeviceRegistration,
  ) {}

  async list(token: string): Promise<CloudDeviceListResponse> {
    const device = await this.deviceRegistration();
    await this.request<void>(
      '/v1/cloud/auth/devices/current',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          displayName: device.displayName,
          platform: device.platform,
          osVersion: device.osVersion,
          appVersion: device.appVersion,
          approximateLocation: device.approximateLocation,
        }),
      },
      'Could not update this device.',
    );
    return this.request<CloudDeviceListResponse>(
      '/v1/cloud/auth/devices',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      'Could not load active devices.',
    );
  }

  rename(
    token: string,
    deviceId: string,
    displayName: string,
    clientOperationId: string = crypto.randomUUID(),
  ): Promise<CloudDeviceMutationResponse> {
    return this.mutate(token, `/v1/cloud/auth/devices/${encodeURIComponent(deviceId)}`, 'PATCH', {
      clientOperationId,
      displayName,
    }, 'Could not rename this device.');
  }

  confirm(
    token: string,
    deviceId: string,
    clientOperationId: string = crypto.randomUUID(),
  ): Promise<CloudDeviceMutationResponse> {
    return this.mutate(token, `/v1/cloud/auth/devices/${encodeURIComponent(deviceId)}/confirm`, 'POST', {
      clientOperationId,
    }, 'Could not confirm this device.');
  }

  revoke(
    token: string,
    deviceId: string,
    clientOperationId: string = crypto.randomUUID(),
  ): Promise<CloudDeviceMutationResponse> {
    return this.mutate(token, `/v1/cloud/auth/devices/${encodeURIComponent(deviceId)}`, 'DELETE', {
      clientOperationId,
    }, 'Could not terminate this device.');
  }

  revokeOthers(
    token: string,
    clientOperationId: string = crypto.randomUUID(),
  ): Promise<CloudDeviceMutationResponse> {
    return this.mutate(token, '/v1/cloud/auth/devices/revoke-others', 'POST', {
      clientOperationId,
    }, 'Could not terminate other devices.');
  }

  private mutate(
    token: string,
    path: string,
    method: 'PATCH' | 'POST' | 'DELETE',
    body: Record<string, string>,
    fallbackMessage: string,
  ): Promise<CloudDeviceMutationResponse> {
    return this.request<CloudDeviceMutationResponse>(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }, fallbackMessage);
  }
}

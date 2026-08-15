import type { CloudSyncEvent } from './authClient';
import { publishCloudCallEvents } from './cloudCalls';
import type { ChatSyncEvent } from './chatSyncTypes';

export function publishCloudDeviceEvents(
  events: ChatSyncEvent[],
  accountId: string,
  currentDeviceId: string | undefined,
  callEvents: CloudSyncEvent[] = [],
): void {
  publishCloudCallEvents(callEvents, accountId);
  if (typeof window === 'undefined' || !events.some((event) => event.type.startsWith('device.'))) {
    return;
  }

  window.dispatchEvent(new CustomEvent('kordi-cloud-devices-changed', {
    detail: { accountId },
  }));
  const newDevice = events.find((event) => (
    event.type === 'device.added'
    && typeof event.payload.deviceId === 'string'
    && event.payload.deviceId !== currentDeviceId
  ));
  if (newDevice) {
    window.dispatchEvent(new CustomEvent('kordi-cloud-new-device', {
      detail: {
        accountId,
        deviceId: newDevice.payload.deviceId,
      },
    }));
  }
}

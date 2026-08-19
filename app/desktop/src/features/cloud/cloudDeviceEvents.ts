import type { CloudSyncEvent } from './authClient';
import { publishCloudCallEvents } from './cloudCalls';
import type { ChatSyncEvent } from './chatSyncTypes';

export const CLOUD_DIRECTORY_SYNC_EVENT = 'kordi-cloud-directory-sync';
export const CLOUD_AGENT_DIRECTORY_SYNC_EVENT = 'kordi-cloud-agent-directory-sync';
export type CloudAgentDirectorySyncDetail = { ownerAccountIds: string[] };

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function chatEventsRequireDirectoryBootstrap(events: ChatSyncEvent[]): boolean {
  return events.some((event) => event.type === 'account.profile.updated'
    || event.type === 'account.directory.changed');
}

export function publishCloudDeviceEvents(
  events: ChatSyncEvent[],
  accountId: string,
  currentDeviceId: string | undefined,
  callEvents: CloudSyncEvent[] = [],
): void {
  publishCloudCallEvents(callEvents, accountId);
  if (typeof window === 'undefined') return;

  const profileEvent = events.find((event) => event.type === 'account.profile.updated');
  const profile = objectRecord(profileEvent?.payload.account);
  if (profile?.accountId === accountId) {
    window.dispatchEvent(new CustomEvent('kordi-cloud-profile-updated', { detail: profile }));
  }
  if (events.some((event) => event.type === 'account.directory.changed')) {
    window.dispatchEvent(new Event(CLOUD_DIRECTORY_SYNC_EVENT));
  }
  const ownerAccountIds = [...new Set(events.flatMap((event) => {
    const ownerAccountId = event.type === 'agent.directory.changed'
      ? event.payload.ownerAccountId
      : null;
    return typeof ownerAccountId === 'string' && ownerAccountId.trim()
      ? [ownerAccountId.trim()]
      : [];
  }))];
  if (ownerAccountIds.length > 0) {
    window.dispatchEvent(new CustomEvent<CloudAgentDirectorySyncDetail>(
      CLOUD_AGENT_DIRECTORY_SYNC_EVENT,
      { detail: { ownerAccountIds } },
    ));
  }

  if (!events.some((event) => event.type.startsWith('device.'))) return;

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

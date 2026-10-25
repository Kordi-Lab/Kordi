import type { ConnectorsClient } from '@/features/connectors/connectorsClient';
import type { ConnectorsLinkProviderId } from '@/features/connectors/connectorsSettingsLink';
import type { CgAgentFile, CgDeviceItem, CgDeviceSource, CgPerson } from './types';

export type CgDeviceStatus = 'granted' | 'denied' | 'not_determined' | 'full_disk_access_missing' | 'unavailable';
export type CgDeviceStatuses = Record<CgDeviceSource, CgDeviceStatus>;

/** Calendar and Reminders on this Mac; null elsewhere. */
export type CgDeviceAccess = {
  status: () => Promise<CgDeviceStatuses>;
  request: (source: CgDeviceSource) => Promise<CgDeviceStatuses>;
  titles: (source: CgDeviceSource) => Promise<CgDeviceItem[]>;
};

/** The account's connectors, through the Connectors client. */
export type CgConnectorsAccess = {
  client: Pick<ConnectorsClient, 'list' | 'disconnect'>;
  /** Opens account settings on the Connectors tab with this provider. */
  openSettings: (providerId: ConnectorsLinkProviderId) => void;
};

/** What the Common ground page needs from the app around it. */
export type CgHost = {
  /** `handle` is the Kordi ID without the @. */
  self: { accountId: string; name: string; avatarUrl: string | null; handle?: string | null };
  /** True when the server has profiles (`commonGroundVersion` 2 or later). */
  profiles?: boolean;
  /** True when profiles keep their sources and documents can be read (`commonGroundVersion` 3). */
  sources?: boolean;
  memoryAvailable: boolean;
  /** True when memories are filed to profiles (`memoryVersion` 2); the card page lists them. */
  memoryRouting?: boolean;
  /** True when a memory may feed several cards (`memoryVersion` 3); card pages add and remove them. */
  memoryCards?: boolean;
  openChat: (person: CgPerson) => void;
  acceptRequest: (requestId: string) => Promise<void>;
  contactsChanged: () => void;
  openGroup: (groupSpaceId: string) => void;
  /** Null when this build has no Connectors client for the account. */
  connectors: CgConnectorsAccess | null;
  /** Agent instruction and memory files on this Mac; null elsewhere. */
  agentFiles: (() => Promise<CgAgentFile[]>) | null;
  device: CgDeviceAccess | null;
  openUrl: (url: string) => void;
};

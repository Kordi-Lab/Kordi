import type { CgDeviceItem, CgDeviceSource, CgPerson } from './types';

export type CgDeviceStatus = 'granted' | 'denied' | 'not_determined' | 'full_disk_access_missing' | 'unavailable';
export type CgDeviceStatuses = Record<CgDeviceSource, CgDeviceStatus>;

/** Calendar and Reminders on this Mac; null elsewhere. */
export type CgDeviceAccess = {
  status: () => Promise<CgDeviceStatuses>;
  request: (source: CgDeviceSource) => Promise<CgDeviceStatuses>;
  titles: (source: CgDeviceSource) => Promise<CgDeviceItem[]>;
};

export type CgConnector = { id: string; name: string };

/** What the Common ground page needs from the app around it. */
export type CgHost = {
  self: { accountId: string; name: string; avatarUrl: string | null };
  memoryAvailable: boolean;
  openChat: (person: CgPerson) => void;
  acceptRequest: (requestId: string) => Promise<void>;
  contactsChanged: () => void;
  openGroup: (groupSpaceId: string) => void;
  listConnectors: () => Promise<CgConnector[]>;
  device: CgDeviceAccess | null;
  openUrl: (url: string) => void;
};

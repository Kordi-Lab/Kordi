import type { CloudDeviceAuthorization } from './cloudDeviceClient';

export type CloudDeviceGroup = {
  key: string;
  title: string;
  platform: string | null;
  osVersion: string | null;
  location: string | null;
  online: boolean;
  lastActiveAt: string | null;
  sessionCount: number;
  devices: CloudDeviceAuthorization[];
  pending: boolean;
};

export type CloudDeviceGrouping = {
  current: CloudDeviceAuthorization | null;
  groups: CloudDeviceGroup[];
  legacy: CloudDeviceAuthorization[];
};

const PLACEHOLDER_OAUTH_NAME = /^oauth-.+-device$/i;
const PLACEHOLDER_PASSWORD_NAME = 'cloud-email-password-device';

const lastActiveDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Names that older servers and clients stored instead of a real device name. */
export function isPlaceholderDeviceName(name: string | null | undefined): boolean {
  const trimmed = name?.trim() ?? '';
  if (!trimmed) return false;
  return PLACEHOLDER_OAUTH_NAME.test(trimmed) || trimmed.toLowerCase() === PLACEHOLDER_PASSWORD_NAME;
}

function platformFallbackTitle(platform: string | null): string {
  switch (platform?.toLowerCase()) {
    case 'macos':
      return 'Mac';
    case 'ios':
      return 'iPhone';
    case 'windows':
      return 'Windows PC';
    case 'linux':
      return 'Linux computer';
    default:
      return 'Kordi device';
  }
}

export function deviceTitle(device: CloudDeviceAuthorization): string {
  const name = device.displayName?.trim();
  if (name && !isPlaceholderDeviceName(name)) return name;
  return platformFallbackTitle(device.platform);
}

export function isPendingReview(device: CloudDeviceAuthorization): boolean {
  return device.authorizationState === 'pending_review';
}

export function isLegacyDevice(device: CloudDeviceAuthorization): boolean {
  return device.legacy === true || isPlaceholderDeviceName(device.displayName);
}

/** Groups rows that belong to the same physical device. Legacy rows get a unique key. */
export function deviceGroupKey(device: CloudDeviceAuthorization): string {
  if (isLegacyDevice(device)) return `legacy::${device.deviceId}`;
  return `${device.platform ?? 'unknown'}::${deviceTitle(device).trim().toLowerCase()}`;
}

function activityTime(value: string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function byMostRecent(left: CloudDeviceAuthorization, right: CloudDeviceAuthorization): number {
  return activityTime(right.lastActiveAt) - activityTime(left.lastActiveAt);
}

function rowSessionCount(device: CloudDeviceAuthorization): number {
  const count = device.sessionCount;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}

function buildGroup(key: string, rows: CloudDeviceAuthorization[]): CloudDeviceGroup {
  const devices = [...rows].sort(byMostRecent);
  const latest = devices[0];
  return {
    key,
    title: deviceTitle(latest),
    platform: latest.platform,
    osVersion: latest.osVersion,
    location: latest.approximateLocation,
    online: devices.some((device) => device.online === true),
    lastActiveAt: latest.lastActiveAt || null,
    sessionCount: devices.reduce((total, device) => total + rowSessionCount(device), 0),
    devices,
    pending: devices.some(isPendingReview),
  };
}

export function groupCloudDevices(devices: CloudDeviceAuthorization[]): CloudDeviceGrouping {
  const current = devices.find((device) => device.currentDevice) ?? null;
  const legacy: CloudDeviceAuthorization[] = [];
  const rowsByKey = new Map<string, CloudDeviceAuthorization[]>();
  for (const device of devices) {
    if (device.currentDevice) continue;
    if (isLegacyDevice(device)) {
      legacy.push(device);
      continue;
    }
    const key = deviceGroupKey(device);
    const rows = rowsByKey.get(key);
    if (rows) rows.push(device);
    else rowsByKey.set(key, [device]);
  }
  const groups = [...rowsByKey.entries()]
    .map(([key, rows]) => buildGroup(key, rows))
    .sort((left, right) => {
      if (left.online !== right.online) return left.online ? -1 : 1;
      return activityTime(right.lastActiveAt) - activityTime(left.lastActiveAt);
    });
  return { current, groups, legacy: legacy.sort(byMostRecent) };
}

export function lastActiveDescription(value: string | null | undefined, now: number = Date.now()): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const elapsed = Math.max(0, now - date.getTime());
  if (elapsed < 60_000) return 'Active just now';
  if (elapsed < 3_600_000) return `Active ${Math.max(1, Math.floor(elapsed / 60_000))} min ago`;
  if (elapsed < 86_400_000) return `Active ${Math.max(1, Math.floor(elapsed / 3_600_000))} hr ago`;
  return `Last active ${lastActiveDateFormatter.format(date)}`;
}

export function signInMethodLabel(method: string | null | undefined): string {
  const normalized = method?.trim().toLowerCase() ?? '';
  switch (normalized) {
    case '':
      return 'Kordi';
    case 'google':
      return 'Google';
    case 'github':
      return 'GitHub';
    case 'password':
    case 'email':
    case 'email_password':
    case 'email-password':
      return 'Email and password';
    default:
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
}

function platformLabel(platform: string | null): string | null {
  switch (platform?.toLowerCase()) {
    case 'macos':
      return 'macOS';
    case 'ios':
      return 'iOS';
    case 'windows':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform?.trim() || null;
  }
}

/** "macOS 26.0", "iOS 18.5", or null when nothing is known. */
export function platformVersionLabel(platform: string | null, osVersion: string | null): string | null {
  return [platformLabel(platform), osVersion?.trim() || null].filter(Boolean).join(' ') || null;
}

/** "Kordi 0.0.2", or "Kordi" when the app version is unknown. */
export function appVersionLabel(appVersion: string | null | undefined): string {
  const version = appVersion?.trim();
  return version ? `Kordi ${version}` : 'Kordi';
}

export function sessionCountLabel(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`;
}

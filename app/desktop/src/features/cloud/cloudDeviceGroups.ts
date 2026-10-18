import type { CloudDeviceAuthorization } from './cloudDeviceClient';

export type CloudDeviceSplit = {
  current: CloudDeviceAuthorization | null;
  /** Other installations on the same machine as the current device. */
  sameMachine: CloudDeviceAuthorization[];
  others: CloudDeviceAuthorization[];
};

const PLACEHOLDER_OAUTH_NAME = /^oauth-.+-device$/i;
const PLACEHOLDER_PASSWORD_NAME = 'cloud-email-password-device';

const lastActiveDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const reviewEndsFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
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

/** Row title: legacy rows have no real device name, so they are named by sign-in method. */
export function deviceRowTitle(device: CloudDeviceAuthorization): string {
  return isLegacyDevice(device) ? `${signInMethodLabel(device.signInMethod)} sign-in` : deviceTitle(device);
}

function activityTime(device: CloudDeviceAuthorization): number {
  if (device.online === true) return Number.MAX_SAFE_INTEGER;
  const time = device.lastActiveAt ? new Date(device.lastActiveAt).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

/** Pending review first, then most recent activity (online counts as now). */
function byReviewThenActivity(left: CloudDeviceAuthorization, right: CloudDeviceAuthorization): number {
  const pending = Number(isPendingReview(right)) - Number(isPendingReview(left));
  return pending || activityTime(right) - activityTime(left);
}

export function splitCloudDevices(devices: CloudDeviceAuthorization[]): CloudDeviceSplit {
  const current = devices.find((device) => device.currentDevice) ?? null;
  const sameMachine: CloudDeviceAuthorization[] = [];
  const others: CloudDeviceAuthorization[] = [];
  for (const device of devices) {
    if (device.currentDevice) continue;
    (device.sameMachine === true ? sameMachine : others).push(device);
  }
  return {
    current,
    sameMachine: sameMachine.sort(byReviewThenActivity),
    others: others.sort(byReviewThenActivity),
  };
}

/** Short date and time a pending review ends, or null when unknown. */
export function reviewEndsLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : reviewEndsFormatter.format(date);
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

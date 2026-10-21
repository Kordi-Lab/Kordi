import { StrictMode, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';

import type { CloudDeviceAuthorization } from '../../src/features/cloud/cloudDeviceClient';
import { CloudDevicesPanel, type CloudDevicesClient } from '../../src/features/cloud/CloudDevicesPanel';
import '../../src/index.css';

const ACCOUNT_ID = 'acct_preview';
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
localStorage.setItem('kordi.themeMode.v1', theme);

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function row(overrides: Partial<CloudDeviceAuthorization> & { deviceId: string }): CloudDeviceAuthorization {
  return {
    displayName: null,
    platform: 'macos',
    osVersion: '26.0',
    appVersion: '0.0.2',
    createdAt: ago(60 * 24 * 30),
    lastActiveAt: ago(1),
    authorizationState: 'confirmed',
    currentDevice: false,
    sessionExpiresAt: null,
    approximateLocation: 'Lisbon, Portugal',
    syncStatus: { protocolVersion: 2, lastAppliedSequence: 0, lastSuccessfulCatchUpAt: null },
    online: false,
    sessionCount: 1,
    legacy: false,
    signInMethod: null,
    sameMachine: false,
    reviewEndsAt: null,
    ...overrides,
  };
}

// `?state=confirmed` shows this device already approved; the default shows it waiting for review.
const currentConfirmed = params.get('state') === 'confirmed';
const reviewEndsAt = new Date(now + 20 * 60 * 60_000).toISOString();

let devices: CloudDeviceAuthorization[] = [
  row({
    deviceId: 'dev_current',
    displayName: 'MacBook Pro',
    osVersion: '27.0.1',
    appVersion: '0.0.2-beta.5.2',
    currentDevice: true,
    online: true,
    lastActiveAt: ago(0),
    authorizationState: currentConfirmed ? 'confirmed' : 'pending_review',
    reviewEndsAt: currentConfirmed ? null : reviewEndsAt,
  }),
  row({
    deviceId: 'dev_same_dev_profile',
    displayName: 'MacBook Pro',
    osVersion: '27.0.1',
    appVersion: '0.0.2-dev',
    sameMachine: true,
    authorizationState: 'pending_review',
    reviewEndsAt: new Date(now + 6 * 60 * 60_000).toISOString(),
    lastActiveAt: ago(40),
  }),
  row({
    deviceId: 'dev_same_old_install',
    displayName: 'MacBook Pro',
    osVersion: '26.0',
    appVersion: '0.0.2-beta.4',
    sameMachine: true,
    lastActiveAt: ago(60 * 20),
  }),
  row({
    deviceId: 'dev_iphone',
    displayName: 'iPhone 17 Pro',
    platform: 'ios',
    osVersion: '26.0',
    appVersion: '0.0.2-beta.5.2',
    online: true,
    lastActiveAt: ago(2),
    approximateLocation: 'Jeddah, Saudi Arabia',
  }),
  row({
    deviceId: 'dev_legacy',
    platform: null,
    osVersion: null,
    appVersion: null,
    legacy: true,
    signInMethod: 'google',
    lastActiveAt: ago(60 * 30),
  }),
];

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const mutation = (affectedDeviceIds: string[]) => ({ affectedDeviceIds });

const previewClient: CloudDevicesClient = {
  async listDevices() {
    await pause();
    return { devices: devices.map((device) => ({ ...device })) };
  },
  async renameDevice(_token, deviceId, displayName) {
    await pause();
    devices = devices.map((device) => (device.deviceId === deviceId ? { ...device, displayName } : device));
    return mutation([deviceId]);
  },
  async confirmDevice(_token, deviceId) {
    await pause();
    devices = devices.map((device) => (
      device.deviceId === deviceId ? { ...device, authorizationState: 'confirmed' as const, reviewEndsAt: null } : device
    ));
    return mutation([deviceId]);
  },
  async revokeDevice(_token, deviceId) {
    await pause();
    devices = devices.filter((device) => device.deviceId !== deviceId);
    return mutation([deviceId]);
  },
  async revokeOtherDevices() {
    await pause();
    const affected = devices.filter((device) => !device.currentDevice).map((device) => device.deviceId);
    devices = devices.filter((device) => device.currentDevice);
    return mutation(affected);
  },
};

const previewSession = () => Promise.resolve({ token: 'preview', accountId: ACCOUNT_ID });

function CloudDevicesPreview() {
  useLayoutEffect(() => {
    document.body.classList.toggle('theme-light', theme === 'light');
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, []);

  return (
    <div
      className={`kordi-app theme-${theme} grid min-h-screen place-items-center p-6`}
      style={theme === 'dark'
        ? { background: '#101824', color: 'rgb(255 255 255)' }
        : { background: 'var(--app-main-bg)', color: 'rgb(15 23 42)' }}
    >
      <div className="app-transient-surface app-modal-panel app-cloud-account-settings-dialog w-[min(760px,calc(100vw-40px))] overflow-hidden rounded-[12px]">
        <div className="app-main-panel app-cloud-account-settings-page">
          <div className="px-8 pb-8 pt-10">
            <CloudDevicesPanel accountId={ACCOUNT_ID} client={previewClient} sessionLoader={previewSession} />
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><CloudDevicesPreview /></StrictMode>);

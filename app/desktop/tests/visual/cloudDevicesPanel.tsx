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
    approximateLocation: 'Thuwal, Saudi Arabia',
    syncStatus: { protocolVersion: 2, lastAppliedSequence: 0, lastSuccessfulCatchUpAt: null },
    online: false,
    sessionCount: 1,
    legacy: false,
    signInMethod: null,
    ...overrides,
  };
}

let devices: CloudDeviceAuthorization[] = [
  row({ deviceId: 'dev_current', displayName: 'Shu’s MacBook Air', currentDevice: true, online: true, lastActiveAt: ago(0) }),
  row({ deviceId: 'dev_studio_1', displayName: 'Mac Studio', appVersion: '0.0.2', online: true, lastActiveAt: ago(2) }),
  row({
    deviceId: 'dev_studio_2',
    displayName: 'Mac Studio',
    appVersion: '0.0.2-beta.3',
    authorizationState: 'pending_review',
    lastActiveAt: ago(45),
  }),
  row({ deviceId: 'dev_studio_3', displayName: 'Mac Studio', osVersion: '15.6', appVersion: '0.0.1', lastActiveAt: ago(60 * 26) }),
  row({
    deviceId: 'dev_iphone',
    displayName: 'iPhone 17 Pro',
    platform: 'ios',
    osVersion: '26.0',
    lastActiveAt: ago(60 * 24 * 2),
    approximateLocation: 'Jeddah, Saudi Arabia',
  }),
  row({ deviceId: 'dev_legacy_1', platform: null, osVersion: null, appVersion: null, legacy: true, signInMethod: 'google', lastActiveAt: ago(60 * 24 * 6) }),
  row({ deviceId: 'dev_legacy_2', displayName: 'oauth-google-device', platform: null, osVersion: null, appVersion: null, signInMethod: 'google', lastActiveAt: ago(60 * 24 * 12) }),
  row({ deviceId: 'dev_legacy_3', platform: null, osVersion: null, appVersion: null, legacy: true, signInMethod: 'password', lastActiveAt: ago(60 * 24 * 20), approximateLocation: null }),
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
      device.deviceId === deviceId ? { ...device, authorizationState: 'confirmed' as const } : device
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

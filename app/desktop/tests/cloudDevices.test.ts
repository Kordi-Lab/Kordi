import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

test('device settings keep session details concise while covering review, stale recovery, and revocation', () => {
  const panel = readSource('features/cloud/CloudDevicesPanel.tsx');
  const settings = readSource('pages/CloudAccountSettingsDialog.tsx');

  assert.match(settings, /id: 'devices', label: 'Active sessions'/);
  assert.match(panel, /This device/);
  assert.match(panel, /Active devices/);
  assert.match(panel, /Rename this device/);
  assert.match(panel, /renameDevice/);
  assert.match(panel, /Terminate all other sessions/);
  assert.match(panel, /authorizationState === 'pending_review'/);
  assert.match(panel, /Showing the last device list/);
  assert.doesNotMatch(panel, /Device details unavailable/);
  assert.match(panel, /lastActiveAt/);
  assert.match(panel, /approximateLocation/);
  assert.doesNotMatch(panel, /First signed in/);
  assert.doesNotMatch(panel, /Sync cursor/);
  assert.doesNotMatch(panel, /Last catch-up/);
  assert.doesNotMatch(panel, /Sync protocol/);
  assert.doesNotMatch(panel, /Session expires/);
  assert.match(panel, /revokeOtherDevices/);
  assert.match(panel, /confirmation\.operationId/);
  assert.match(panel, /cannot erase files already saved/);
});

test('the sidebar routes device review through settings instead of the profile menu', () => {
  const sidebar = readSource('pages/workspaceSidebar.profile.tsx');
  const sync = readSource('features/cloud/useCloudMessageSync.ts');
  const deviceEvents = readSource('features/cloud/cloudDeviceEvents.ts');

  assert.match(sidebar, /accountId === cloudAccount\.accountId/);
  assert.match(sidebar, /if \(tab === 'devices' && cloudAccount\)/);
  assert.match(sidebar, /needsReview: false/);
  assert.doesNotMatch(sidebar, /Review active sessions/);
  assert.match(sidebar, /openCloudAccountDialog\(hasDeviceReview \? 'devices' : 'profile'\)/);
  assert.match(sync, /publishCloudDeviceEvents\(response\.chat\.events/);
  assert.match(deviceEvents, /event\.type === 'device\.added'/);
  assert.match(deviceEvents, /kordi-cloud-new-device/);
});

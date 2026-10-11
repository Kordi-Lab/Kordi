import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

import {
  CLOUD_AGENT_DIRECTORY_SYNC_EVENT,
  CLOUD_DIRECTORY_SYNC_EVENT,
  publishCloudDeviceEvents,
} from '../src/features/cloud/cloudDeviceEvents';
import type { ChatSyncEvent } from '../src/features/cloud/chatSyncTypes';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

test('device settings keep session details concise while covering review and revocation', () => {
  const panel = readSource('features/cloud/CloudDevicesPanel.tsx');
  const groups = readSource('features/cloud/cloudDeviceGroups.ts');
  const parts = readSource('features/cloud/CloudDevicesPanelParts.tsx');
  const dialogs = readSource('features/cloud/CloudDevicesPanelDialogs.tsx');
  const settings = readSource('pages/cloudAccountSettingsNav.ts');

  assert.match(settings, /id: 'devices', label: 'Active sessions'/);
  assert.match(panel, /This device/);
  assert.match(panel, /Other devices/);
  assert.match(panel, /Older sign-ins/);
  assert.match(dialogs, /Rename this device/);
  assert.match(panel, /renameDevice/);
  assert.match(panel, /Log out of all other devices/);
  assert.match(parts, /Log out of this device/);
  assert.match(panel, /Log out of all older sign-ins/);
  for (const source of [panel, dialogs]) assert.doesNotMatch(source, /Terminate/);
  assert.match(groups, /authorizationState === 'pending_review'/);
  assert.match(parts, /Active now/);
  assert.match(parts, /This was me/);
  for (const source of [panel, parts, dialogs]) {
    assert.doesNotMatch(source, /Showing the last device list/);
    assert.doesNotMatch(source, /Device details unavailable/);
    assert.doesNotMatch(source, /First signed in/);
    assert.doesNotMatch(source, /Sync cursor/);
    assert.doesNotMatch(source, /Last catch-up/);
    assert.doesNotMatch(source, /Sync protocol/);
    assert.doesNotMatch(source, /Session expires/);
  }
  assert.match(panel, /lastActiveAt/);
  assert.match(panel, /approximateLocation/);
  assert.match(panel, /revokeOtherDevices/);
  assert.match(panel, /confirmation\.operationId/);
  assert.match(panel, /No other devices\./);
  assert.match(dialogs, /Every device except this one will be signed out\./);
  assert.match(dialogs, /will be signed out\./);
  assert.match(panel, /This device is not in the list\. Refresh and try again\./);
  for (const source of [panel, parts, dialogs]) {
    assert.doesNotMatch(source, /cannot erase files/);
    assert.doesNotMatch(source, /will not be erased/);
    assert.doesNotMatch(source, /Review the installations/);
    assert.doesNotMatch(source, /Signs out every other device/);
    assert.doesNotMatch(source, /did not report device details/);
    assert.doesNotMatch(source, /will appear here after they sign in/);
    assert.doesNotMatch(source, /\buppercase\b/);
    assert.doesNotMatch(source, /tracking-\[/);
  }
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

test('durable directory events refresh profiles without replacing the signed-in account', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements = {
    window: dom.window,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
  };
  const previous = new Map(Object.keys(replacements).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)],
  ));
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  let profileAccountId = '';
  let directoryRefreshes = 0;
  let changedAgentOwners: string[] = [];
  dom.window.addEventListener('kordi-cloud-profile-updated', (event) => {
    profileAccountId = (event as CustomEvent<{ accountId?: string }>).detail?.accountId ?? '';
  });
  dom.window.addEventListener(CLOUD_DIRECTORY_SYNC_EVENT, () => { directoryRefreshes += 1; });
  dom.window.addEventListener(CLOUD_AGENT_DIRECTORY_SYNC_EVENT, (event) => {
    changedAgentOwners = (event as CustomEvent<{ ownerAccountIds?: string[] }>)
      .detail?.ownerAccountIds ?? [];
  });
  const event = (type: string, payload: Record<string, unknown>): ChatSyncEvent => ({
    stream_seq: 1,
    event_id: type,
    protocol_version: 2,
    type,
    critical: true,
    conversation_id: null,
    entity_id: null,
    entity_version: null,
    occurred_at: '2026-08-19T00:00:00Z',
    payload,
  });

  try {
    publishCloudDeviceEvents([
      event('account.profile.updated', { account: { accountId: 'acct_me' } }),
      event('account.directory.changed', { accountId: 'acct_peer' }),
      event('agent.directory.changed', { ownerAccountId: 'acct_owner' }),
    ], 'acct_me', undefined);
    assert.equal(profileAccountId, 'acct_me');
    assert.equal(directoryRefreshes, 1);
    assert.deepEqual(changedAgentOwners, ['acct_owner']);
  } finally {
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
    dom.window.close();
  }
});

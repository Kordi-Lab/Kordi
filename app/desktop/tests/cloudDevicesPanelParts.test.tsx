import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { CloudDeviceAuthorization } from '../src/features/cloud/cloudDeviceClient';
import { CurrentDeviceCard, DeviceRow } from '../src/features/cloud/CloudDevicesPanelParts';

function device(overrides: Partial<CloudDeviceAuthorization> = {}): CloudDeviceAuthorization {
  return {
    deviceId: 'dev',
    displayName: 'MacBook Pro',
    platform: 'macos',
    osVersion: '27.0.1',
    appVersion: '0.0.2-beta.5.2',
    createdAt: '2026-10-01T00:00:00Z',
    lastActiveAt: '2026-10-01T00:00:00Z',
    authorizationState: 'confirmed',
    currentDevice: false,
    sessionExpiresAt: null,
    approximateLocation: 'Thuwal, Saudi Arabia',
    syncStatus: { protocolVersion: 2, lastAppliedSequence: 0, lastSuccessfulCatchUpAt: null },
    ...overrides,
  };
}

const noop = () => {};

function row(target: CloudDeviceAuthorization, actionsHidden: boolean): string {
  return renderToStaticMarkup(
    createElement(DeviceRow, { device: target, busy: false, actionsHidden, onConfirm: noop, onLogOut: noop }),
  );
}

test('a pending current device shows the waiting badge and approval note', () => {
  const html = renderToStaticMarkup(
    createElement(CurrentDeviceCard, {
      device: device({ currentDevice: true, authorizationState: 'pending_review' }),
      title: 'MacBook Pro',
      details: 'macOS 27.0.1 · Kordi 0.0.2-beta.5.2',
      note: 'Approve from another device, or wait until Oct 18, 3:00 PM.',
    }),
  );
  assert.match(html, /Waiting for approval/);
  assert.match(html, /Approve from another device, or wait until Oct 18, 3:00 PM\./);
  assert.doesNotMatch(html, /Active now/);
});

test('a confirmed current device shows activity, not the approval note', () => {
  const html = renderToStaticMarkup(
    createElement(CurrentDeviceCard, {
      device: device({ currentDevice: true }),
      title: 'MacBook Pro',
      details: null,
      note: 'Approve from another device.',
    }),
  );
  assert.match(html, /Active now/);
  assert.doesNotMatch(html, /Waiting for approval|Approve from another device/);
});

test('rows offer review actions only while the current device is approved', () => {
  const pending = device({ authorizationState: 'pending_review', online: true });
  const withActions = row(pending, false);
  assert.match(withActions, /Needs review/);
  assert.match(withActions, /This was me/);
  assert.match(withActions, /aria-label="Log out MacBook Pro"/);
  assert.match(withActions, /Kordi 0\.0\.2-beta\.5\.2/);
  assert.match(withActions, /Active now/);

  const locked = row(pending, true);
  assert.match(locked, /Needs review/);
  assert.doesNotMatch(locked, /This was me|Log out/);

  const confirmed = row(device(), false);
  assert.doesNotMatch(confirmed, /This was me|Needs review/);
  assert.match(confirmed, /Log out MacBook Pro/);
  assert.match(confirmed, /Last active/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ConnectorsSettingsPanel } from '../src/features/connectors/ConnectorsSettingsPanel';
import { createPreviewConnectorsClient } from '../src/features/connectors/connectorsClient';
import { connectorDefinition, connectScopes } from '../src/features/connectors/connectorsModel';
import { buttonByText, click, flush, installDom } from './helpers/connectorsPanelDom';

test('Calendar connect previews read only and requires a separate acting consent', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const client = createPreviewConnectorsClient({ latencyMs: 0 });
    await client.disconnect('google_calendar');
    await act(async () => root.render(<ConnectorsSettingsPanel accountId="synthetic-owner" client={client} isNativeShell={false} />));
    await flush();
    await click(host.querySelector('[data-connector-row="google_calendar"] button'), installed.dom.window);
    await click(host.querySelector('[aria-label="Connect Google Calendar"]'), installed.dom.window);
    const dialog = document.querySelector('[role="dialog"]');
    assert.match(dialog?.textContent ?? '', /read-only Calendar access/);
    assert.match(dialog?.textContent ?? '', /Acting stays off/);
    const definition = connectorDefinition('google_calendar');
    assert.deepEqual(connectScopes(definition), definition.readScopes);
    for (const scope of definition.actScopes) assert.ok(!dialog?.textContent?.includes(scope.label));
    await click(buttonByText(document.body, 'Continue to Google'), installed.dom.window);
    await flush();
    assert.equal(host.querySelector('[aria-label="Let my agent act in Google Calendar"]')?.getAttribute('aria-checked'), 'false');
    await click(host.querySelector('[aria-label="Let my agent act in Google Calendar"]'), installed.dom.window);
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /additional permission from Google/);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('Act off does not hide provider-granted write permissions', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const client = createPreviewConnectorsClient({ latencyMs: 0 });
    await client.setActEnabled('google_calendar', false);
    await act(async () => root.render(<ConnectorsSettingsPanel accountId="synthetic-owner" client={client} isNativeShell={false} />));
    await flush();
    await click(host.querySelector('[data-connector-row="google_calendar"] button'), installed.dom.window);
    assert.match(host.textContent ?? '', /Provider permissions/);
    assert.match(host.textContent ?? '', /Google still grants write access/);
    for (const scope of connectorDefinition('google_calendar').actScopes) assert.ok(host.textContent?.includes(scope.label));
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('missing OAuth setup is explained before opening consent', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const client = createPreviewConnectorsClient({ latencyMs: 0 });
    await client.disconnect('google_calendar');
    const list = client.list.bind(client);
    client.list = async () => {
      const response = await list();
      return { ...response, states: response.states.map((state) => state.providerId === 'google_calendar' ? { ...state, oauthReady: false } : state) };
    };
    await act(async () => root.render(<ConnectorsSettingsPanel accountId="synthetic-owner" client={client} isNativeShell={false} />));
    await flush();
    assert.match(host.querySelector('[data-connector-row="google_calendar"]')?.textContent ?? '', /Setup required/);
    await click(host.querySelector('[data-connector-row="google_calendar"] button'), installed.dom.window);
    assert.match(host.textContent ?? '', /Ask your Kordi administrator to enable Google Calendar connections/);
    assert.equal(host.querySelector('[aria-label="Connect Google Calendar"]'), null);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

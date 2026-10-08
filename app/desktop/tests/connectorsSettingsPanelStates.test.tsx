// Panel states added with the server-backed client: the sample notice, the
// Kordi Cloud checking and unreachable lines, and canceling a pending connect.

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ConnectorsSettingsPanel } from '../src/features/connectors/ConnectorsSettingsPanel';
import { createPreviewConnectorsClient } from '../src/features/connectors/connectorsClient';
import type { ConnectorState } from '../src/features/connectors/connectorsModel';
import { buttonByText, click, flush, installDom } from './helpers/connectorsPanelDom';

test('the sample notice shows only for the preview client', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const client = createPreviewConnectorsClient({ latencyMs: 0 });
    await act(async () => {
      root.render(<ConnectorsSettingsPanel accountId="account-1" client={client} isNativeShell={false} />);
    });
    await flush();
    assert.match(host.textContent ?? '', /Google Calendar/);
    assert.doesNotMatch(host.textContent ?? '', /Showing sample connectors/);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('the services section says when Kordi Cloud is loading or unreachable', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const client = createPreviewConnectorsClient({ latencyMs: 0 });
    await act(async () => {
      root.render(<ConnectorsSettingsPanel accountId="account-1" client={client} isNativeShell servicesStatus="checking" />);
    });
    await flush();
    assert.match(host.textContent ?? '', /Checking Kordi Cloud…/);
    assert.equal(host.querySelector('[data-connector-row="github"]'), null, 'service rows are hidden while checking');
    assert.ok(host.querySelector('[data-connector-row="mac_calendar"]'), 'Mac-local rows still show');

    let retries = 0;
    await act(async () => {
      root.render(
        <ConnectorsSettingsPanel accountId="account-1" client={client} isNativeShell servicesStatus="unreachable" onRetryServices={() => { retries += 1; }} />,
      );
    });
    await flush();
    assert.match(host.textContent ?? '', /Could not reach Kordi Cloud\./);
    await click(buttonByText(host, 'Try again'), installed.dom.window);
    assert.equal(retries, 1);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('canceling a pending connect aborts the flow', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const preview = createPreviewConnectorsClient({ latencyMs: 0 });
    let aborted = false;
    const client = {
      ...preview,
      connect: (_providerId: string, input: { signal?: AbortSignal }) => new Promise<ConnectorState>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('Connecting Gmail was canceled.'));
        });
      }),
    } as typeof preview;
    await act(async () => {
      root.render(<ConnectorsSettingsPanel accountId="account-1" client={client} isNativeShell />);
    });
    await flush();
    await click(host.querySelector('[data-connector-row="gmail"] button'), installed.dom.window);
    await click(host.querySelector('[aria-label="Connect Gmail"]'), installed.dom.window);
    await click(buttonByText(document.body, 'Continue to Google'), installed.dom.window);
    assert.match(document.body.textContent ?? '', /Waiting for Google…/);
    const cancel = buttonByText(document.body, 'Cancel');
    assert.equal(cancel?.disabled, false, 'Cancel stays enabled while busy');
    await click(cancel, installed.dom.window);
    assert.equal(aborted, true);
    assert.doesNotMatch(document.body.textContent ?? '', /Continue to Google/);
    assert.equal(host.querySelector('[role="alert"]'), null, 'a cancel is not an error');
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

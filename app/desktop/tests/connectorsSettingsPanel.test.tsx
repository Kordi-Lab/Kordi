import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ConnectorsSettingsPanel } from '../src/features/connectors/ConnectorsSettingsPanel';
import {
  connectorsClientForEnvironment,
  connectorsClientForFlag,
  createPreviewConnectorsClient,
} from '../src/features/connectors/connectorsClient';
import {
  connectorCatalog,
  connectorDefinition,
  connectorListValue,
  connectorStatusLabel,
  connectorToolGroupsForRun,
  disconnectConsequences,
  type ConnectorState,
} from '../src/features/connectors/connectorsModel';
import { cloudAccountSettingsNavGroups } from '../src/pages/cloudAccountSettingsNav';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  return {
    dom,
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

const connectedState: ConnectorState = {
  providerId: 'google_calendar',
  status: 'connected',
  connectedAt: '2026-10-01T00:00:00.000Z',
  grantedScopeIds: [],
  actEnabled: true,
  agentIds: ['agent-default'],
  lastEventAt: null,
};

test('background runs only ever receive read tools', () => {
  assert.deepEqual(connectorToolGroupsForRun(connectedState, { startedByPerson: false }), ['read']);
  assert.deepEqual(connectorToolGroupsForRun(connectedState, { startedByPerson: true }), ['read', 'act']);
  assert.deepEqual(connectorToolGroupsForRun({ ...connectedState, actEnabled: false }, { startedByPerson: true }), ['read']);
  assert.deepEqual(connectorToolGroupsForRun({ ...connectedState, status: 'not_connected' }, { startedByPerson: true }), []);
  assert.deepEqual(connectorToolGroupsForRun({ ...connectedState, status: 'needs_reauth' }, { startedByPerson: true }), []);
});

test('disconnect explains the token, stored events, derived copies, and Memory', () => {
  const lines = disconnectConsequences(connectorDefinition('gmail'));
  assert.equal(lines.length, 3);
  const text = lines.join(' ');
  assert.match(text, /token/i);
  assert.match(text, /stored events/i);
  assert.match(text, /copies/i);
  assert.match(text, /Memory/);
});

test('status labels describe access and agent grants', () => {
  const agents = [
    { agentId: 'agent-default', name: 'My Kordi', isDefault: true },
    { agentId: 'agent-research', name: 'Research', isDefault: false },
  ];
  const calendar = connectorDefinition('google_calendar');
  assert.equal(connectorStatusLabel(calendar, connectedState, agents), 'Connected · Can act · 1 agent');
  assert.equal(
    connectorStatusLabel(calendar, { ...connectedState, actEnabled: false, agentIds: ['agent-default', 'agent-research'] }, agents),
    'Connected · Read only · All agents',
  );
  assert.equal(connectorStatusLabel(calendar, undefined, agents), 'Not connected');
  assert.equal(connectorStatusLabel(calendar, { ...connectedState, status: 'needs_reauth' }, agents), 'Sign in again');
  assert.equal(
    connectorStatusLabel(connectorDefinition('mac_notification_center'), { ...connectedState, status: 'permission_missing' }, agents),
    'Needs Full Disk Access',
  );
  assert.equal(connectorStatusLabel(connectorDefinition('outlook'), undefined, agents), 'Not yet available');
});

test('list values omit agent counts', () => {
  const calendar = connectorDefinition('google_calendar');
  assert.equal(connectorListValue(calendar, connectedState), 'Connected · Can act');
  assert.equal(connectorListValue(calendar, { ...connectedState, actEnabled: false }), 'Connected · Read only');
  assert.equal(connectorListValue(calendar, undefined), 'Not connected');
  assert.equal(connectorListValue(calendar, { ...connectedState, status: 'needs_reauth' }), 'Sign in again');
  assert.equal(
    connectorListValue(connectorDefinition('mac_notification_center'), { ...connectedState, status: 'permission_missing' }),
    'Needs Full Disk Access',
  );
  assert.equal(connectorListValue(connectorDefinition('outlook'), undefined), 'Coming later');
});

test('the preview client never exposes token-like fields', async () => {
  const client = createPreviewConnectorsClient({ latencyMs: 0 });
  const result = await client.list();
  const keys: string[] = [];
  JSON.stringify(result, (key, value) => {
    if (key) keys.push(key);
    return value;
  });
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((key) => /token|secret/i.test(key)), []);
  assert.equal(result.states.length, connectorCatalog.length);
});

test('preview client grants act on purpose and disconnect clears audit entries', async () => {
  const client = createPreviewConnectorsClient({ latencyMs: 0 });
  const connected = await client.connect('gmail', { scopeIds: [] });
  assert.equal(connected.status, 'connected');
  assert.equal(connected.actEnabled, false);
  await assert.rejects(client.setActEnabled('gmail', true));
  const granted = await client.grantAct('gmail');
  assert.equal(granted.actEnabled, true);
  assert.ok(granted.grantedScopeIds.includes('gmail.messages.send'));

  assert.ok((await client.auditLog('github')).length > 0);
  await client.disconnect('github');
  assert.deepEqual(await client.auditLog('github'), []);

  const notifications = await client.recheckPermission('mac_notification_center');
  assert.equal(notifications.status, 'connected');
});

test('connectors stay hidden unless the preview flag is set', () => {
  assert.equal(connectorsClientForFlag(undefined), null);
  assert.equal(connectorsClientForFlag('0'), null);
  assert.notEqual(connectorsClientForFlag('1'), null);
  assert.equal(connectorsClientForEnvironment(), null);
});

test('account settings show Connectors only when a client is available', () => {
  const ids = (connectorsAvailable: boolean) => cloudAccountSettingsNavGroups({ connectorsAvailable })
    .flatMap((group) => group.items.map((item) => item.id));
  assert.deepEqual(ids(false), ['profile', 'devices', 'auth', 'notifications', 'appearance']);
  assert.deepEqual(ids(true), ['profile', 'devices', 'auth', 'notifications', 'connectors', 'appearance']);
  const connectors = cloudAccountSettingsNavGroups({ connectorsAvailable: true })
    .flatMap((group) => group.items)
    .find((item) => item.id === 'connectors');
  assert.equal(connectors?.label, 'Connectors');
});

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function click(element: Element | null | undefined, window: JSDOM['window']) {
  assert.ok(element, 'expected an element to click');
  await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  await flush();
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === text);
}

test('panel lists each connector as a navigation row with a status value', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const client = createPreviewConnectorsClient({ latencyMs: 0 });
    await act(async () => {
      root.render(<ConnectorsSettingsPanel accountId="account-1" client={client} isNativeShell />);
    });
    await flush();

    const text = host.textContent ?? '';
    assert.match(text, /Showing sample connectors/);
    for (const definition of connectorCatalog) {
      const row = host.querySelector(`[data-connector-row="${definition.providerId}"]`);
      assert.ok(row, `missing row for ${definition.name}`);
      assert.ok(row.textContent?.includes(definition.name));
      const hasChevron = Boolean(row.querySelector('.app-settings-row-chevron'));
      assert.equal(hasChevron, definition.availability === 'available', `${definition.name} chevron`);
    }
    const row = (id: string) => host.querySelector(`[data-connector-row="${id}"]`)?.textContent ?? '';
    assert.match(row('google_calendar'), /Connected · Can act$/);
    assert.match(row('github'), /Connected · Read only$/);
    assert.match(row('slack'), /Sign in again$/);
    assert.match(row('gmail'), /Not connected$/);
    assert.match(row('outlook'), /Coming later$/);
    assert.equal(host.querySelector('[data-connector-row="outlook"] button'), null);
    assert.match(row('mac_notification_center'), /Notification CenterExperimental/);
    assert.match(row('mac_notification_center'), /Needs Full Disk Access$/);

    await click(host.querySelector('[data-connector-row="google_calendar"] button'), installed.dom.window);
    assert.equal(host.querySelector('h1')?.textContent, 'Google Calendar');
    assert.ok(host.querySelector('[aria-label="Let my agent act in Google Calendar"]'));
    assert.match(host.textContent ?? '', /Connected · Can act · 1 agent/);
    assert.match(host.textContent ?? '', /Default agent/);
    assert.doesNotMatch(host.textContent ?? '', /Showing sample connectors/);

    await click(buttonByText(host, 'Back to connectors'), installed.dom.window);
    assert.equal(host.querySelector('h1'), null);
    assert.ok(host.querySelector('[data-connector-row="gmail"]'));

    await click(host.querySelector('[data-connector-row="mac_notification_center"] button'), installed.dom.window);
    assert.match(host.textContent ?? '', /Experimental, read-only, best effort\./);
    assert.match(host.textContent ?? '', /What it reads/);
    await click(buttonByText(host, 'Back to connectors'), installed.dom.window);

    await click(host.querySelector('[data-connector-row="github"] button'), installed.dom.window);
    await click(host.querySelector('[aria-label="Let my agent act in GitHub"]'), installed.dom.window);
    assert.match(document.body.textContent ?? '', /Let your agent act in GitHub/);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('connecting from the detail view stays on the detail with read access', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const client = createPreviewConnectorsClient({ latencyMs: 0 });
    await act(async () => {
      root.render(<ConnectorsSettingsPanel accountId="account-1" client={client} isNativeShell />);
    });
    await flush();

    await click(host.querySelector('[data-connector-row="gmail"] button'), installed.dom.window);
    assert.equal(host.querySelector('h1')?.textContent, 'Gmail');
    assert.match(host.textContent ?? '', /Not connected/);
    await click(host.querySelector('[aria-label="Connect Gmail"]'), installed.dom.window);
    assert.match(document.body.textContent ?? '', /Kordi asks Google for read access only\./);
    await click(buttonByText(document.body, 'Continue to Google'), installed.dom.window);
    await flush();

    assert.equal(host.querySelector('h1')?.textContent, 'Gmail');
    assert.match(host.textContent ?? '', /Connected · Read only · 1 agent/);
    assert.ok(host.querySelector('[aria-label="Let my agent act in Gmail"]'));
    assert.doesNotMatch(document.body.textContent ?? '', /Continue to Google/);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test('panel hides Mac-local connectors outside the native shell', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    const client = createPreviewConnectorsClient({ latencyMs: 0 });
    await act(async () => {
      root.render(<ConnectorsSettingsPanel accountId="account-1" client={client} isNativeShell={false} />);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const text = host.textContent ?? '';
    assert.match(text, /Google Calendar/);
    assert.doesNotMatch(text, /On this Mac/);
    assert.doesNotMatch(text, /Notification Center/);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

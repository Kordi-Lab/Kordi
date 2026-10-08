import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ConnectorsSettingsPanel } from '../src/features/connectors/ConnectorsSettingsPanel';
import {
  connectorsClientForEnvironment,
  connectorsClientForFlag,
  connectorsSelectionForEnvironment,
  createDesktopMacLocalConnectorsClient,
  createPreviewConnectorsClient,
  type DesktopInvoke,
  type MacLocalConnectorsState,
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
  assert.deepEqual(
    disconnectConsequences(connectorDefinition('mac_contacts')),
    ['Kordi stops reading Contacts on this Mac. Nothing was stored.'],
  );
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

test('desktop client merges Mac-local command state with the service rows', async () => {
  let macLocal: MacLocalConnectorsState = {
    calendar: { enabled: true, permission: 'granted' },
    contacts: { enabled: false, permission: 'not_determined' },
    notification_center: { enabled: false, permission: 'full_disk_access_missing' },
  };
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke: DesktopInvoke = async <T,>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'desktop_mac_local_connectors_set_enabled') {
      const source = args?.source as keyof MacLocalConnectorsState;
      if (source === 'notification_center' && args?.enabled) throw new Error('Notification Center needs Full Disk Access.');
      // A refused permission keeps the source off, as the desktop command does.
      const permission = source === 'contacts' ? 'denied' : macLocal[source].permission;
      macLocal = { ...macLocal, [source]: { enabled: Boolean(args?.enabled) && permission === 'granted', permission } };
    }
    return macLocal as T;
  };
  const services = createPreviewConnectorsClient({ latencyMs: 0 });
  const client = createDesktopMacLocalConnectorsClient(invoke, services);

  const listed = await client.list();
  const byId = new Map(listed.states.map((state) => [state.providerId, state]));
  assert.equal(listed.states.length, connectorCatalog.length);
  assert.equal(byId.get('mac_calendar')?.status, 'connected');
  assert.equal(byId.get('mac_calendar')?.actEnabled, false);
  assert.deepEqual(byId.get('mac_calendar')?.grantedScopeIds, connectorDefinition('mac_calendar').readScopes.map((scope) => scope.id));
  assert.equal(byId.get('mac_contacts')?.status, 'not_connected');
  assert.equal(byId.get('mac_notification_center')?.status, 'permission_missing');
  assert.equal(byId.get('github')?.status, 'connected', 'service rows still come from the preview client');
  assert.ok(listed.agents.length > 0);

  const contacts = await client.connect('mac_contacts', { scopeIds: [] });
  assert.equal(contacts.status, 'permission_missing');
  assert.equal(contacts.enabled, false);
  assert.equal(connectorListValue(connectorDefinition('mac_contacts'), contacts), 'Needs permission');
  assert.deepEqual(calls.at(-1), { command: 'desktop_mac_local_connectors_set_enabled', args: { source: 'contacts', enabled: true } });

  const notifications = await client.connect('mac_notification_center', { scopeIds: [] });
  assert.equal(notifications.status, 'permission_missing');
  assert.equal(calls.at(-1)?.command, 'desktop_mac_local_connectors_recheck');

  await client.disconnect('mac_calendar');
  assert.deepEqual(calls.at(-1), { command: 'desktop_mac_local_connectors_set_enabled', args: { source: 'calendar', enabled: false } });
  assert.equal((await client.recheckPermission('mac_calendar')).status, 'not_connected');
  assert.equal(calls.at(-1)?.command, 'desktop_mac_local_connectors_recheck');
  await assert.rejects(client.grantAct('mac_calendar'), /not available yet/);

  // On but without permission: still offers Disconnect and grants nothing.
  macLocal = { ...macLocal, contacts: { enabled: true, permission: 'denied' } };
  const onWithoutPermission = (await client.list()).states.find((state) => state.providerId === 'mac_contacts');
  assert.equal(onWithoutPermission?.status, 'permission_missing');
  assert.equal(onWithoutPermission?.enabled, true);
  assert.deepEqual(onWithoutPermission?.grantedScopeIds, []);
  assert.equal(connectorListValue(connectorDefinition('mac_contacts'), onWithoutPermission), 'On · needs permission');
  assert.equal(client.servicesAvailable, true);

  const withoutServices = createDesktopMacLocalConnectorsClient(invoke, null);
  assert.equal(withoutServices.servicesAvailable, false);
  const bare = await withoutServices.list();
  assert.equal(bare.states.find((state) => state.providerId === 'github')?.status, 'not_connected');
  await assert.rejects(withoutServices.connect('github', { scopeIds: [] }), /not available yet/);
});

test('connectors stay hidden unless the preview flag is set', () => {
  assert.equal(connectorsClientForFlag(undefined), null);
  assert.equal(connectorsClientForFlag('0'), null);
  assert.notEqual(connectorsClientForFlag('1'), null);
  assert.equal(connectorsClientForEnvironment(), null);
});

test('the desktop shell gets Mac-local connectors only on macOS', () => {
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const saved = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  const fakeShell = (platform: string, userAgent: string) => {
    Object.defineProperty(target, 'window', { configurable: true, writable: true, value: { __TAURI_INTERNALS__: {} } });
    Object.defineProperty(target, 'navigator', { configurable: true, writable: true, value: { platform, userAgent } });
  };
  const invoke: DesktopInvoke = async () => { throw new Error('not called'); };
  try {
    fakeShell('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    const mac = connectorsSelectionForEnvironment(undefined, invoke);
    assert.ok(mac, 'macOS shows the Mac-local rows');
    assert.equal(mac.isPreview, false);
    assert.equal(mac.client.servicesAvailable, false);
    const macPreview = connectorsSelectionForEnvironment('1', invoke);
    assert.equal(macPreview?.isPreview, true);
    assert.equal(macPreview?.client.servicesAvailable, true);

    fakeShell('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    assert.equal(connectorsSelectionForEnvironment(undefined, invoke), null);
    fakeShell('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)');
    assert.equal(connectorsSelectionForEnvironment(undefined, invoke), null);
    const linuxPreview = connectorsSelectionForEnvironment('1', invoke);
    assert.equal(linuxPreview?.isPreview, true);
    assert.notEqual(linuxPreview?.client.servicesAvailable, false);
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    }
  }
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
      root.render(<ConnectorsSettingsPanel accountId="account-1" client={client} isNativeShell isPreview />);
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

test('Mac-only panel hides Services and sample copy, and a source on without permission can be turned off', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let macLocal: MacLocalConnectorsState = {
    calendar: { enabled: true, permission: 'granted' },
    contacts: { enabled: true, permission: 'denied' },
    notification_center: { enabled: false, permission: 'full_disk_access_missing' },
  };
  const invoke: DesktopInvoke = async <T,>(command: string, args?: Record<string, unknown>) => {
    if (command === 'desktop_mac_local_connectors_set_enabled' && args?.enabled === false) {
      const source = args.source as keyof MacLocalConnectorsState;
      macLocal = { ...macLocal, [source]: { ...macLocal[source], enabled: false } };
    }
    return macLocal as T;
  };
  try {
    const client = createDesktopMacLocalConnectorsClient(invoke, null);
    await act(async () => {
      root.render(<ConnectorsSettingsPanel accountId="account-1" client={client} isNativeShell />);
    });
    await flush();
    const text = host.textContent ?? '';
    assert.doesNotMatch(text, /Services/);
    assert.doesNotMatch(text, /Google Calendar/);
    assert.doesNotMatch(text, /Showing sample connectors/);
    assert.match(text, /On this Mac/);
    const row = (id: string) => host.querySelector(`[data-connector-row="${id}"]`)?.textContent ?? '';
    assert.match(row('mac_calendar'), /Connected · Read only$/);
    assert.match(row('mac_contacts'), /On · needs permission$/);

    await click(host.querySelector('[data-connector-row="mac_calendar"] button'), installed.dom.window);
    const detail = host.textContent ?? '';
    assert.match(detail, /Connected · Read only · All agents/);
    assert.match(detail, /All agents on this Mac/);
    assert.match(detail, /Stops reading Calendar and Reminders on this Mac\./);
    assert.equal(host.querySelector('[aria-label="Let my agent act in Calendar and Reminders"]'), null);
    assert.equal(host.querySelector('[aria-label="Let My Kordi use Calendar and Reminders"]'), null);
    assert.doesNotMatch(detail, /Activity log/);
    await click(buttonByText(host, 'Back to connectors'), installed.dom.window);

    await click(host.querySelector('[data-connector-row="mac_contacts"] button'), installed.dom.window);
    assert.match(host.textContent ?? '', /On · needs permission/);
    assert.ok(buttonByText(host, 'Open System Settings'));
    await click(host.querySelector('[aria-label="Check Contacts permission again"]'), installed.dom.window);
    assert.match(host.textContent ?? '', /Contacts still needs permission to control Contacts\./);
    await click(host.querySelector('[aria-label="Disconnect Contacts"]'), installed.dom.window);
    assert.match(document.body.textContent ?? '', /Kordi stops reading Contacts on this Mac\. Nothing was stored\./);
    const dialog = document.body.querySelector('[role="dialog"], dialog');
    await click(Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent === 'Disconnect'), installed.dom.window);
    await flush();
    assert.equal(host.querySelector('h1'), null);
    assert.match(row('mac_contacts'), /Needs permission$/);
    assert.equal(macLocal.contacts.enabled, false);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

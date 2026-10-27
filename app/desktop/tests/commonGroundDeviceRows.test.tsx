import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { DeviceRows, type CgDeviceTitles } from '../src/features/commonGround/BuildDeviceRows';
import type { CgDeviceAccess, CgDeviceStatuses, CgHost } from '../src/features/commonGround/host';
import type { CgDeviceItem, CgDeviceSource } from '../src/features/commonGround/types';
import { installDom } from './helpers/transcriptAttachmentDom';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mount(device: CgDeviceAccess, initial: CgDeviceSource[] = []) {
  const environment = installDom();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let snapshot!: { titles: CgDeviceTitles; included: CgDeviceSource[] };
  let writes = 0;
  const host = { device, openUrl: () => {} } as unknown as CgHost;
  function Harness() {
    const [titles, setTitles] = useState<CgDeviceTitles>({});
    const [included, setIncluded] = useState(initial);
    const trackTitles = useCallback((update: (current: CgDeviceTitles) => CgDeviceTitles) => {
      ++writes;
      setTitles(update);
    }, []);
    snapshot = { titles, included };
    return <DeviceRows host={host} titles={titles} setTitles={trackTitles} included={included} setIncluded={setIncluded} />;
  }
  await act(async () => root.render(<Harness />));
  return {
    container, snapshot: () => snapshot, writes: () => writes,
    button: (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!,
    focus: () => act(async () => { window.dispatchEvent(new window.Event('focus')); }),
    unmount: () => act(async () => root.unmount()),
    restore: () => { container.remove(); environment.restore(); },
  };
}

const statuses = (calendar: CgDeviceStatuses['calendar']): CgDeviceStatuses => ({ calendar, reminders: 'granted' });
const items: CgDeviceItem[] = [{ title: 'Gym', date: '2026-10-26' }];

test('device read errors stay distinct from empty results and retry preserves source choices', async () => {
  let fail = true;
  let requests = 0;
  const view = await mount({
    status: async () => statuses('granted'),
    request: async () => { ++requests; return statuses('granted'); },
    titles: async (source) => {
      if (source === 'calendar' && fail) throw 'Native read failed';
      return items;
    },
  }, ['reminders']);
  try {
    assert.ok(view.container.textContent?.includes('Could not read Calendar.'));
    assert.ok(!view.container.textContent?.includes('Nothing found'));
    assert.equal(view.snapshot().titles.calendar, undefined);
    assert.deepEqual(view.snapshot().titles.reminders, items, 'one source failure does not discard the other');
    assert.ok(view.button('Reminders').getAttribute('aria-checked') === 'true');
    fail = false;
    await act(async () => view.button('Retry Calendar').click());
    assert.deepEqual(view.snapshot().titles.calendar, items);
    assert.deepEqual(view.snapshot().included, ['reminders'], 'retry must not enable a source');
    assert.equal(requests, 0, 'retry must not ask for system permission');
    fail = true;
    await view.focus();
    assert.equal(view.snapshot().titles.calendar, undefined, 'failed refresh clears previously read evidence');
  } finally { await view.unmount(); view.restore(); }
});

test('permission refresh clears evidence, ignores older reads, and never prompts or auto-selects', async () => {
  const older = deferred<CgDeviceItem[]>();
  let permission: CgDeviceStatuses['calendar'] = 'granted';
  let first = true;
  let requests = 0;
  const view = await mount({
    status: async () => statuses(permission),
    request: async () => { ++requests; return statuses('granted'); },
    titles: async (source) => {
      if (source === 'calendar' && first) { first = false; return older.promise; }
      return items;
    },
  }, ['calendar']);
  try {
    assert.ok(view.container.textContent?.includes('Reading…'));
    permission = 'denied';
    await view.focus();
    assert.ok(view.container.textContent?.includes('Access is off'));
    assert.equal(view.snapshot().titles.calendar, undefined);
    await act(async () => older.resolve(items));
    assert.equal(view.snapshot().titles.calendar, undefined, 'older result cannot restore data after denial');
    permission = 'granted';
    await view.focus();
    assert.deepEqual(view.snapshot().titles.calendar, items);
    assert.deepEqual(view.snapshot().included, ['calendar'], 'saved choices survive permission changes');
    assert.equal(requests, 0);
    await act(async () => view.button('Calendar').click());
    permission = 'denied';
    await view.focus();
    assert.equal(view.snapshot().titles.calendar, undefined, 'revocation clears completed reads too');
    permission = 'granted';
    await view.focus();
    assert.deepEqual(view.snapshot().included, [], 'focus refresh must not turn an unselected source on');
    assert.equal(requests, 0);
  } finally { await view.unmount(); view.restore(); }
});

test('empty Calendar describes its date window and explicit Allow can select a source', async () => {
  let permission: CgDeviceStatuses['calendar'] = 'not_determined';
  let requests = 0;
  const view = await mount({
    status: async () => statuses(permission),
    request: async () => { ++requests; permission = 'granted'; return statuses(permission); },
    titles: async () => [],
  });
  try {
    await act(async () => view.button('Allow Calendar').click());
    assert.equal(requests, 1);
    assert.deepEqual(view.snapshot().included, ['calendar']);
    assert.ok(view.container.textContent?.includes('No titles in the past 180 or next 60 days.'));
    assert.ok(view.button('Retry Calendar'));
    assert.ok(!view.container.textContent?.includes('Could not read'));
  } finally { await view.unmount(); view.restore(); }
});

test('status failures are retryable and pending reads cannot publish after unmount', async () => {
  const pending = deferred<CgDeviceItem[]>();
  let fail = true;
  const view = await mount({
    status: async () => { if (fail) throw new Error('Status failed'); return statuses('granted'); },
    request: async () => statuses('granted'), titles: () => pending.promise,
  });
  try {
    assert.ok(view.container.textContent?.includes('Could not check access.'));
    fail = false;
    await act(async () => view.button('Retry Calendar').click());
    assert.ok(view.container.textContent?.includes('Reading…'));
    await view.unmount();
    const writes = view.writes();
    await act(async () => pending.resolve(items));
    assert.equal(view.writes(), writes, 'unmounted source cannot receive evidence');
  } finally { await view.unmount(); view.restore(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { CloudUsagePanel, type CloudUsageClient } from '../src/features/cloud/CloudUsagePanel';
import { formatUtcClock, type OrganizationUsageSummary, type UsageSnapshot } from '../src/features/cloud/usageClient';
import { usageBarTone, usageLabel, usageStatusLine, usageValueLabel } from '../src/features/cloud/usagePresentation';

const RESETS_AT = '2026-11-05T00:00:00.000Z';
const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  limitId: 'pool.runs', scope: 'pool', usedPercent: 50, window: 'day', resetsAt: RESETS_AT, reached: 'none', ...overrides,
});

test('bar colour follows the 75% and 90% thresholds and reached limits', () => {
  assert.equal(usageBarTone(snapshot({ usedPercent: 74 })), 'accent');
  assert.equal(usageBarTone(snapshot({ usedPercent: 75 })), 'amber');
  assert.equal(usageBarTone(snapshot({ usedPercent: 89 })), 'amber');
  assert.equal(usageBarTone(snapshot({ usedPercent: 90 })), 'red');
  assert.equal(usageBarTone(snapshot({ usedPercent: 10, reached: 'daily_limit' })), 'red');
  assert.equal(usageBarTone(snapshot({ usedPercent: 0, reached: 'stopped' })), 'red');
});

test('labels and values', () => {
  assert.equal(usageLabel(snapshot({ limitId: 'conversation.system_agent_runs', scope: 'conversation' })), 'System agent per chat');
  assert.equal(usageLabel(snapshot({ limitId: 'pool.stopped' })), 'System agent');
  assert.equal(usageValueLabel(snapshot({ used: 7, limit: 10, usedPercent: 70 })), '7 of 10');
  assert.equal(usageValueLabel(snapshot({ limitId: 'pool.spend', used: 400_000, limit: 1_000_000, usedPercent: 40 })), '0.40 of 1.00');
  assert.equal(usageValueLabel(snapshot({ usedPercent: 70 })), '70%');
  assert.equal(formatUtcClock('2026-11-04T14:20:00Z'), '14:20');
  assert.equal(formatUtcClock('soon'), '00:00');
});

test('the line under a row depends on the viewer role', () => {
  assert.equal(usageStatusLine(snapshot(), 'member'), 'Resets at 00:00 UTC');
  const reached = snapshot({ usedPercent: 100, reached: 'daily_limit' });
  assert.equal(usageStatusLine(reached, 'owner'), 'Limit reached. Resets at 00:00 UTC.');
  assert.equal(usageStatusLine(reached, 'admin'), 'Limit reached. Resets at 00:00 UTC.');
  assert.equal(usageStatusLine(reached, 'member'), 'Limit reached. Resets at 00:00 UTC. Ask an owner to raise it.');
  assert.equal(usageStatusLine({ ...reached, reached: 'spend_limit' }, null), 'Limit reached. Resets at 00:00 UTC. Ask an owner to raise it.');
  const paused = { ...reached, pausedSince: '2026-11-04T14:20:00Z' };
  assert.equal(usageStatusLine(paused, 'owner'), 'Paused since 14:20, resets 00:00 UTC.');
  assert.equal(usageStatusLine(paused, 'member'), 'Paused since 14:20, resets 00:00 UTC. Ask an owner to raise it.');
  assert.equal(usageStatusLine(snapshot({ limitId: 'pool.stopped', reached: 'stopped' }), 'member'), 'Paused by an owner.');
});

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.entries(replacements).forEach(([key, value]) => Object.defineProperty(target, key, { configurable: true, writable: true, value }));
  return () => {
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
    dom.window.close();
  };
}

function fakeClient(role: 'owner' | 'member'): CloudUsageClient {
  const amounts = role === 'owner';
  const organization: OrganizationUsageSummary = {
    organizationId: 'org_team', name: 'Example team', kind: 'team', role,
    snapshots: [
      snapshot({ usedPercent: 70, ...(amounts ? { used: 7, limit: 10 } : {}) }),
      snapshot({ limitId: 'pool.spend', usedPercent: 100, reached: 'spend_limit', pausedSince: '2026-11-04T14:20:00Z', ...(amounts ? { used: 1_000_000, limit: 1_000_000 } : {}) }),
    ],
  };
  const empty: OrganizationUsageSummary = { organizationId: 'org_empty', name: 'Quiet team', kind: 'team', role, snapshots: [] };
  return { accountUsage: async () => [organization, empty] };
}

async function renderPanel(accountId: string, client: CloudUsageClient) {
  const restore = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(CloudUsagePanel, { accountId, client, sessionLoader: async () => ({ token: 'token', accountId }) }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    return {
      text: host.textContent ?? '',
      tones: [...host.querySelectorAll('[data-usage-tone]')].map((row) => row.getAttribute('data-usage-tone')),
    };
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

test('the Usage tab shows amounts to owners and percentages to members', async () => {
  const owner = await renderPanel('acct_owner', fakeClient('owner'));
  assert.match(owner.text, /Example team/);
  assert.match(owner.text, /Runs.*7 of 10/);
  assert.match(owner.text, /Spend.*1\.00 of 1\.00/);
  assert.match(owner.text, /Paused since 14:20, resets 00:00 UTC\./);
  assert.doesNotMatch(owner.text, /Ask an owner/);
  assert.match(owner.text, /Quiet team.*No limits\./);
  assert.deepEqual(owner.tones, ['accent', 'red']);

  const member = await renderPanel('acct_member', fakeClient('member'));
  assert.match(member.text, /Runs.*70%/);
  assert.match(member.text, /Spend.*100%/);
  assert.match(member.text, /Ask an owner to raise it\./);
  assert.doesNotMatch(member.text, / of /);
});

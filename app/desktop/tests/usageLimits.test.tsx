import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { CloudUsagePanel, type CloudUsageClient } from '../src/features/cloud/CloudUsagePanel';
import {
  __resetUsageCacheForTests,
  formatUtcClock,
  primeOrganizations,
  type CloudOrganization,
  type OrganizationUsage,
} from '../src/features/cloud/usageClient';
import { parseUsageLimit, usageLimitNoticeCopy } from '../src/features/cloud/usageLimitNotice';
import { KORDI_SYSTEM_AVATAR_URL } from '../src/features/systemAgent/systemAgentIdentity';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { CanonicalIdentity, CanonicalSessionMessage } from '../src/kordi-app/types';

const RESETS_AT = '2026-11-05T00:00:00.000Z';
const systemAgent: CanonicalIdentity = {
  id: 'human:acct_kordi_pip', kind: 'human', displayName: 'System', source: 'bridge', sourceHostId: 'cloud',
  sourceIdentityId: 'acct_kordi_pip', humanId: 'acct_kordi_pip', profileImageUrl: KORDI_SYSTEM_AVATAR_URL,
  createdAtMs: 1, updatedAtMs: 1,
} as CanonicalIdentity;

function limitNotice(text: string, usageLimit: unknown, messageKind = 'system-notice'): CanonicalSessionMessage {
  return {
    id: `group-message:${text}`,
    sessionId: 'session:group:one',
    senderIdentityId: systemAgent.id,
    senderRole: 'person',
    messageKind,
    contentText: text,
    content: { schema: 1, blocks: [{ type: 'text', text }], legacy_attachments: [], usageLimit },
    status: 'received',
    sequenceNum: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    sourceTransport: 'cloud-group',
  };
}

function mapped(text: string, usageLimit: unknown, messageKind?: string) {
  const message = mapCanonicalMessage(limitNotice(text, usageLimit, messageKind), new Map([[systemAgent.id, systemAgent]]), 'human:me');
  assert.ok(message);
  return message;
}

const organizations: CloudOrganization[] = [
  { organizationId: 'org_personal', name: 'Personal', kind: 'personal', role: 'owner', memberCount: 1, createdAt: RESETS_AT },
  { organizationId: 'org_team', name: 'Example team', kind: 'team', role: 'owner', memberCount: 4, createdAt: RESETS_AT },
  { organizationId: 'org_guild', name: 'Design guild', kind: 'team', role: 'member', memberCount: 9, createdAt: RESETS_AT },
];

afterEach(() => __resetUsageCacheForTests());

test('system notices carry a parsed usage limit; malformed values are ignored', () => {
  const message = mapped('Daily limit reached. Resets at 00:00 UTC.', { reached: 'daily_limit', resetsAt: RESETS_AT, organizationId: 'org_team' });
  assert.deepEqual(message.usageLimit, { reached: 'daily_limit', resetsAt: RESETS_AT, organizationId: 'org_team' });
  assert.equal(message.text, 'Daily limit reached. Resets at 00:00 UTC.');

  assert.equal(mapped('Plain notice.', { reached: 'over_quota', resetsAt: RESETS_AT }).usageLimit, undefined);
  assert.equal(mapped('Plain notice.', 'daily_limit').usageLimit, undefined);
  assert.equal(mapped('Plain notice.', undefined).usageLimit, undefined);
  assert.equal(mapped('Not a notice.', { reached: 'daily_limit' }, 'text').usageLimit, undefined);
  assert.equal('usageLimit' in mapped('Plain notice.', null), false);

  assert.deepEqual(parseUsageLimit({ reached: 'stopped', resetsAt: 'soon', organizationId: '' }), { reached: 'stopped', resetsAt: null, organizationId: null });
  assert.equal(formatUtcClock('2026-11-05T07:30:00Z'), '07:30');
  assert.equal(formatUtcClock(null), '00:00');
});

test('limit copy depends on the viewer role', () => {
  const limit = { reached: 'daily_limit' as const, resetsAt: RESETS_AT, organizationId: 'org_team' };
  assert.deepEqual(usageLimitNoticeCopy(limit, 'owner'), { text: 'Daily limit reached. Resets at 00:00 UTC.', showUsageLink: true });
  assert.deepEqual(usageLimitNoticeCopy(limit, 'admin'), { text: 'Daily limit reached. Resets at 00:00 UTC.', showUsageLink: true });
  const ask = { text: 'Daily limit reached. Resets at 00:00 UTC. Ask an owner to raise it.', showUsageLink: false };
  assert.deepEqual(usageLimitNoticeCopy(limit, 'member'), ask);
  assert.deepEqual(usageLimitNoticeCopy(limit, null), ask);
  assert.deepEqual(usageLimitNoticeCopy({ ...limit, organizationId: null }, 'owner'), ask);
  assert.deepEqual(usageLimitNoticeCopy({ ...limit, reached: 'stopped' }, 'owner'), { text: 'Paused by an owner.', showUsageLink: false });
});

test('chat bubbles show role-aware limit lines', () => {
  primeOrganizations('acct_me', organizations);
  const render = (organizationId: string | null, reached = 'daily_limit') => renderToStaticMarkup(createElement(MessageBubble, {
    msg: mapped(reached === 'stopped' ? 'Paused by an owner.' : 'Daily limit reached. Resets at 00:00 UTC.', { reached, resetsAt: RESETS_AT, organizationId }),
    onOpenSenderProfile: () => {},
  }));

  const owner = render('org_team');
  assert.match(owner, /Daily limit reached\. Resets at 00:00 UTC\./);
  assert.match(owner, />View usage</);
  assert.doesNotMatch(owner, /Ask an owner/);

  const member = render('org_guild');
  assert.match(member, /Ask an owner to raise it\./);
  assert.doesNotMatch(member, /View usage/);

  const unknown = render('org_elsewhere');
  assert.match(unknown, /Ask an owner to raise it\./);
  assert.doesNotMatch(unknown, /View usage/);

  const stopped = render('org_team', 'stopped');
  assert.match(stopped, /Paused by an owner\./);
  assert.doesNotMatch(stopped, /View usage|Daily limit/);
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
  const usage: OrganizationUsage = {
    organizationId: 'org_team',
    role,
    notices: amounts ? [{ threshold: 90, at: RESETS_AT }] : [],
    snapshots: [
      { limitId: 'pool.runs', scope: 'pool', usedPercent: 70, window: 'day', resetsAt: RESETS_AT, reached: 'none', ...(amounts ? { used: 7, limit: 10 } : {}) },
      { limitId: 'pool.spend', scope: 'pool', usedPercent: 100, window: 'day', resetsAt: RESETS_AT, reached: 'spend_limit', ...(amounts ? { used: 1_000_000, limit: 1_000_000 } : {}) },
    ],
  };
  return {
    listOrganizations: async () => [{ ...organizations[1]!, role }],
    organizationUsage: async () => usage,
  };
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
    return host.textContent ?? '';
  } finally {
    await act(async () => root.unmount());
    restore();
  }
}

test('the Usage panel shows amounts to owners and percentages to members', async () => {
  const owner = await renderPanel('acct_owner', fakeClient('owner'));
  assert.match(owner, /Example team/);
  assert.match(owner, /90% of today's limit used\./);
  assert.match(owner, /Runs.*7 of 10/);
  assert.match(owner, /Spend.*1\.00 of 1\.00/);
  assert.match(owner, /Resets at 00:00 UTC/);
  assert.match(owner, /Daily limit reached\. Resets at 00:00 UTC\./);

  const member = await renderPanel('acct_member', fakeClient('member'));
  assert.match(member, /Runs.*70%/);
  assert.match(member, /Spend.*100%/);
  assert.doesNotMatch(member, / of /);
  assert.doesNotMatch(member, /today's limit used/);
});

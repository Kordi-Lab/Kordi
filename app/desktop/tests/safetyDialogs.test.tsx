import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { CloudAuthError } from '../src/features/cloud/authClient';
import { BlockedAccountsPanel } from '../src/features/safety/BlockedAccountsPanel';
import { useContactSafetyMenuItems } from '../src/features/safety/contactSafetyMenuItems';
import { useSafetyActions } from '../src/features/safety/safetyActions';
import type { SafetyClient, SafetyDeps } from '../src/features/safety/safetyClient';
import { SafetyActionsProvider } from '../src/features/safety/SafetyActionsProvider';
import type { CloudBlockedAccount, CloudReportInput, ReportTarget } from '../src/features/safety/safetyTypes';
import { __resetCloudBlocksForTests } from '../src/features/safety/useCloudBlocks';
import { MessageContextMenuContent } from '../src/kordi-app/components/messageContextMenuContent';
import type { Message } from '../src/kordi-app/types';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

const CONVERSATION_ID = '0b9f6c1e-3c1e-4b8a-9d55-1f2a3b4c5d6e';
const MESSAGE_ID = '7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6';

type Recorded = { blocked: string[]; unblocked: string[]; reports: CloudReportInput[]; contactRefreshes: number };

function fakeDeps(initial: CloudBlockedAccount[], options: { failFirstReport?: boolean; listStatus?: 404 } = {}) {
  const recorded: Recorded = { blocked: [], unblocked: [], reports: [], contactRefreshes: 0 };
  let blocks = [...initial];
  let failReport = options.failFirstReport ?? false;
  const client: SafetyClient = {
    listBlocks: async () => {
      if (options.listStatus === 404) throw new CloudAuthError('unknown', 'Not found', 404);
      return blocks;
    },
    block: async (_token, accountId) => {
      recorded.blocked.push(accountId);
      const row = { accountId, kordiId: '', displayName: 'Sam Rivera', avatarUrl: null, blockedAt: '2026-11-05T00:00:00Z' };
      blocks = [row, ...blocks];
      return { block: row, removedContact: true };
    },
    unblock: async (_token, accountId) => {
      recorded.unblocked.push(accountId);
      blocks = blocks.filter((row) => row.accountId !== accountId);
    },
    report: async (_token, input) => {
      recorded.reports.push(input);
      if (failReport) {
        failReport = false;
        throw new Error('offline');
      }
      return {
        report: {
          reportId: 'rep_1', reference: 'R-ABCD1234', status: 'received', reason: input.reason,
          targetKind: input.messageIds ? 'message' : 'account', evidenceMessageCount: input.messageIds?.length ?? 0,
          reportedDisplayName: 'Sam Rivera', createdAt: '2026-11-05T00:00:00Z', closedAt: null,
        },
        blocked: input.alsoBlock === true,
      };
    },
    resolveConversationId: async (_token, id) => (id === 'session-1' ? CONVERSATION_ID : id),
  };
  const deps: SafetyDeps = { client, loadSession: async () => ({ token: 'tok', accountId: 'acct_me' }) };
  return { deps, recorded };
}

async function mount(children: ReactNode, deps: SafetyDeps, recorded: Recorded) {
  __resetCloudBlocksForTests();
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const refreshContacts = async () => { recorded.contactRefreshes += 1; };
  await act(async () => {
    root.render(createElement(SafetyActionsProvider, { accountId: 'acct_me', refreshContacts, deps, children }));
  });
  await flushReactUpdates();
  const click = (element: Element | null | undefined) => act(async () => {
    assert.ok(element, 'element to click should exist');
    element.dispatchEvent(new installed.dom.window.MouseEvent('click', { bubbles: true }));
  });
  return {
    body: () => document.body.textContent ?? '',
    dialog: () => document.body.querySelector('[role="dialog"]'),
    button: (text: string) => [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === text),
    click,
    async cleanup() {
      await act(async () => root.unmount());
      installed.restore();
      __resetCloudBlocksForTests();
    },
  };
}

function OpenButtons({ report, onBlocked }: { report: ReportTarget; onBlocked?: () => void }) {
  const safety = useSafetyActions();
  return createElement('div', null,
    createElement('button', { type: 'button', onClick: () => safety.openReport(report) }, 'open report'),
    createElement('button', { type: 'button', onClick: () => safety.openBlock({ accountId: 'acct_sam', name: 'Sam Rivera' }, onBlocked) }, 'open block'),
  );
}

test('the report dialog sends one report per choice set and can also block', async () => {
  const { deps, recorded } = fakeDeps([], { failFirstReport: true });
  const target: ReportTarget = { accountId: 'acct_sam', name: 'Sam Rivera', conversationId: 'session-1', messageIds: [MESSAGE_ID] };
  const page = await mount(createElement(OpenButtons, { report: target }), deps, recorded);
  try {
    await page.click(page.button('open report'));
    assert.match(page.dialog()?.textContent ?? '', /^Report message/);
    for (const label of ['Spam', 'Harassment or hate', 'Sexual or violent content', 'Something else', 'Also block Sam Rivera']) {
      assert.match(page.body(), new RegExp(label));
    }
    assert.equal(page.button('Send')?.disabled, true, 'Send waits for a reason');

    const harassment = [...document.body.querySelectorAll('input[type="radio"]')].find((input) => (input as HTMLInputElement).value === 'harassment');
    await page.click(harassment);
    assert.ok(document.body.querySelector('textarea[aria-label="Add details (optional)"][placeholder="Add details (optional)"]'));
    await page.click(document.body.querySelector('[role="switch"][aria-label="Also block Sam Rivera"]'));
    await page.click(page.button('Send'));
    await flushReactUpdates();
    assert.match(page.body(), /Couldn't send\. Try again\./);

    await page.click(page.button('Send'));
    await flushReactUpdates();
    assert.equal(recorded.reports.length, 2);
    assert.equal(recorded.reports[0].clientReportId, recorded.reports[1].clientReportId, 'a retry reuses the id');
    assert.deepEqual({ ...recorded.reports[1], clientReportId: 'id' }, {
      clientReportId: 'id', reason: 'harassment', reportedAccountId: 'acct_sam',
      conversationId: CONVERSATION_ID, messageIds: [MESSAGE_ID], alsoBlock: true,
    });
    assert.match(page.dialog()?.textContent ?? '', /Report sent/);
    assert.equal(recorded.contactRefreshes, 1, 'an also-block refreshes contacts');

    await page.click(page.button('Done'));
    assert.equal(page.dialog(), null);
  } finally {
    await page.cleanup();
  }
});

test('blocking confirms with the approved copy, refreshes contacts, and runs the follow-up', async () => {
  const { deps, recorded } = fakeDeps([]);
  let closed = 0;
  const page = await mount(createElement(OpenButtons, { report: { accountId: 'acct_sam', name: 'Sam Rivera' }, onBlocked: () => { closed += 1; } }), deps, recorded);
  try {
    await page.click(page.button('open block'));
    assert.equal(page.dialog()?.textContent, "Block Sam Rivera?They can't message, call or invite you.CancelBlock");
    await page.click(page.button('Block'));
    await flushReactUpdates();
    assert.deepEqual(recorded.blocked, ['acct_sam']);
    assert.equal(recorded.contactRefreshes, 1);
    assert.equal(closed, 1);
    assert.equal(page.dialog(), null);

    // Already blocked: the report dialog no longer offers "Also block".
    await page.click(page.button('open report'));
    assert.match(page.dialog()?.textContent ?? '', /^Report Sam Rivera/);
    assert.doesNotMatch(page.body(), /Also block/);
  } finally {
    await page.cleanup();
  }
});

test('the Blocked page lists blocked people and unblocks after confirmation', async () => {
  const sam = { accountId: 'acct_sam', kordiId: '100200300', displayName: 'Sam Rivera', avatarUrl: null, blockedAt: '2026-11-05T00:00:00Z' };
  const { deps, recorded } = fakeDeps([sam]);
  const page = await mount(createElement(BlockedAccountsPanel), deps, recorded);
  try {
    assert.match(page.body(), /BlockedSam Rivera@100200300Unblock/);
    await page.click(document.body.querySelector('button[aria-label="Unblock Sam Rivera"]'));
    assert.equal(page.dialog()?.textContent, 'Unblock Sam Rivera?CancelUnblock');
    await page.click([...(page.dialog()?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Unblock'));
    await flushReactUpdates();
    assert.deepEqual(recorded.unblocked, ['acct_sam']);
    assert.match(page.body(), /No one blocked/);
  } finally {
    await page.cleanup();
  }
});

function ContactMenuProbe({ accountId }: { accountId: string | null }) {
  const items = useContactSafetyMenuItems(accountId, 'Sam Rivera');
  return createElement('ul', null, items.map((item) => (
    item.kind === 'item' ? createElement('li', { key: item.key }, `${item.label}:${item.disabled ? 'off' : 'on'}`) : null
  )));
}

test('Block and Report turn on only when the server supports blocking', async () => {
  const supported = fakeDeps([]);
  let page = await mount(createElement('div', null,
    createElement(ContactMenuProbe, { accountId: 'acct_sam' }),
    createElement(ContactMenuProbe, { accountId: 'acct_kordi_support' }),
  ), supported.deps, supported.recorded);
  try {
    assert.match(page.body(), /Block:onReport:onBlock:offReport:off/);
  } finally {
    await page.cleanup();
  }

  const older = fakeDeps([], { listStatus: 404 });
  page = await mount(createElement(ContactMenuProbe, { accountId: 'acct_sam' }), older.deps, older.recorded);
  try {
    assert.match(page.body(), /Block:offReport:off/);
  } finally {
    await page.cleanup();
  }
});

test('the message menu offers Report for other people’s hosted messages only', async () => {
  const peer: Message = {
    id: 'm1', role: 'person', sender: 'Sam Rivera', senderType: 'human', senderIdentityId: 'human:acct_sam', isOwnMessage: false,
    text: 'hello', time: '', reactionConversationId: CONVERSATION_ID, reactionTargetMessageId: MESSAGE_ID,
  };
  const own: Message = { ...peer, role: 'user', isOwnMessage: true, senderIdentityId: 'human:acct_me' };
  const { deps, recorded } = fakeDeps([]);
  const page = await mount(createElement('div', null,
    createElement('section', { 'data-probe': 'peer' }, createElement(MessageContextMenuContent, { msg: peer })),
    createElement('section', { 'data-probe': 'own' }, createElement(MessageContextMenuContent, { msg: own })),
  ), deps, recorded);
  try {
    const actions = (probe: string) => [...document.body.querySelectorAll(`[data-probe="${probe}"] [data-message-context-menu-action]`)]
      .map((element) => element.getAttribute('data-message-context-menu-action'));
    assert.ok(actions('peer').includes('report'));
    assert.ok(!actions('own').includes('report'));
    await page.click(document.body.querySelector('[data-probe="peer"] [data-message-context-menu-action="report"]'));
    assert.match(page.dialog()?.textContent ?? '', /^Report message/);
    assert.match(page.body(), /Also block Sam Rivera/);
  } finally {
    await page.cleanup();
  }
});

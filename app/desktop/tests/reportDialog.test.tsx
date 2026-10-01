import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CloudAuthError } from '../src/features/cloud/authClient';
import { ReportDialog } from '../src/features/safety/ReportDialog';
import { buildReportInput, REPORT_PRIVACY_FOOTER } from '../src/features/safety/reportReasons';
import type { CloudReportInput, CloudReportReceipt, ReportTarget } from '../src/features/safety/safetyTypes';
import { mountInDom } from './helpers/safetyDom';

const conversationId = '00000000-0000-4000-8000-0000000000aa';
const messageTarget: ReportTarget = {
  accountId: 'acct_bea',
  name: 'Bea',
  conversationId,
  messageIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'],
};

const receipt: CloudReportReceipt = {
  reportId: 'rpt_abcdef0123456789abcdef0123456789',
  reference: 'R-ABCDEF01',
  status: 'received',
  reason: 'harassment',
  targetKind: 'message',
  evidenceMessageCount: 2,
  reportedDisplayName: 'Bea',
  createdAt: '2026-10-01T00:00:00Z',
  closedAt: null,
};

function staticMarkup(target: ReportTarget) {
  return renderToStaticMarkup(createElement(ReportDialog, {
    target,
    onDismiss: () => undefined,
    onSubmit: async () => receipt,
    onBlock: async () => undefined,
  }));
}

test('a message report names the person and says exactly what is included', () => {
  const markup = staticMarkup(messageTarget);

  assert.match(markup, />Report messages from Bea</);
  assert.match(markup, /What&#x27;s happening\?/);
  for (const label of ['Spam', 'Harassment or bullying', 'Scam or fraud', 'Pretending to be someone else', 'Inappropriate or harmful content', 'Something else']) {
    assert.match(markup, new RegExp(`type="radio"[^>]*/>${label}<`));
  }
  assert.match(markup, /2 messages you selected\. Only these messages are included/);
  assert.match(markup, /Anything else we should know\? \(optional\)/);
  assert.match(markup, /1000 characters left/);
  assert.match(markup, /Also block Bea/);
  assert.ok(markup.includes(REPORT_PRIVACY_FOOTER));
  assert.match(markup, /<button[^>]*type="submit"[^>]*disabled=""[^>]*aria-describedby="[^"]+"/);
});

test('an account report says no messages are included', () => {
  const markup = staticMarkup({ accountId: 'acct_bea', name: 'Bea' });
  assert.match(markup, />Report Bea</);
  assert.match(markup, /No messages are included\. To include messages, choose Report on a message\./);
});

test('the request body carries ids and choices only', () => {
  assert.deepEqual(buildReportInput(messageTarget, 'spam', '  rude  ', 'id-1'), {
    clientReportId: 'id-1',
    reason: 'spam',
    details: 'rude',
    reportedAccountId: 'acct_bea',
    conversationId,
    messageIds: messageTarget.messageIds,
  });
  assert.deepEqual(buildReportInput({ accountId: 'acct_bea', name: 'Bea', contactRequestId: 'req_1' }, 'other', ' ', 'id-2'), {
    clientReportId: 'id-2',
    reason: 'other',
    reportedAccountId: 'acct_bea',
    contactRequestId: 'req_1',
  });
  assert.deepEqual(buildReportInput({ accountId: null, name: 'An agent', conversationId, messageIds: ['m', 'm'] }, 'scam', '', 'id-3'), {
    clientReportId: 'id-3',
    reason: 'scam',
    conversationId,
    messageIds: ['m'],
  });
});

test('sending a report shows the receipt and blocks when asked', async () => {
  const dom = await mountInDom();
  const submitted: CloudReportInput[] = [];
  let blocked = 0;
  try {
    await dom.render(createElement(ReportDialog, {
      target: messageTarget,
      onDismiss: () => undefined,
      onSubmit: async (input) => { submitted.push(input); return receipt; },
      onBlock: async () => { blocked += 1; },
    }));
    const send = () => dom.findButton('Send report');
    assert.equal(send()?.disabled, true, 'a reason is required');

    await dom.click(dom.document.querySelector<HTMLInputElement>('input[value="harassment"]') ?? undefined);
    assert.equal(send()?.disabled, false);
    await dom.type(dom.document.querySelector('textarea'), 'Repeated messages after I asked them to stop.');
    assert.match(dom.text(), /955 characters left/);
    await dom.click(dom.document.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? undefined);
    await dom.click(send());

    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.reason, 'harassment');
    assert.equal(submitted[0]?.details, 'Repeated messages after I asked them to stop.');
    assert.deepEqual(submitted[0]?.messageIds, messageTarget.messageIds);
    assert.equal(blocked, 1);
    assert.match(dom.text(), /Report sent/);
    assert.match(dom.text(), /Reference R-ABCDEF01\. Thanks for telling us\./);
    assert.match(dom.text(), /Bea is blocked\./);
    assert.ok(dom.findButton('Done'));
  } finally {
    await dom.cleanup();
  }
});

test('a failed report keeps the selections and retries as the same report', async () => {
  const dom = await mountInDom();
  const submitted: CloudReportInput[] = [];
  let attempt = 0;
  try {
    await dom.render(createElement(ReportDialog, {
      target: messageTarget,
      onDismiss: () => undefined,
      onSubmit: async (input) => {
        submitted.push(input);
        attempt += 1;
        if (attempt === 1) throw new CloudAuthError('network_error', 'offline', 0);
        if (attempt === 2) throw new CloudAuthError('rate_limited', 'Too many', 429);
        return receipt;
      },
    }));
    await dom.click(dom.document.querySelector<HTMLInputElement>('input[value="spam"]') ?? undefined);
    await dom.type(dom.document.querySelector('textarea'), 'details');
    await dom.click(dom.findButton('Send report'));

    assert.match(dom.text(), /Couldn't send your report\. Your selections are kept\. Try again\./);
    assert.equal(dom.document.querySelector<HTMLInputElement>('input[value="spam"]')?.checked, true);
    assert.equal(dom.document.querySelector('textarea')?.value, 'details');
    assert.equal(dom.document.querySelector('input[type="checkbox"]'), null, 'no block option without a block action');

    await dom.click(dom.findButton('Send report'));
    assert.match(dom.text(), /You've sent a lot of reports recently\. Try again later\./);
    assert.equal(submitted[0]?.clientReportId, submitted[1]?.clientReportId, 'a retry is the same report');

    await dom.click(dom.document.querySelector<HTMLInputElement>('input[value="scam"]') ?? undefined);
    await dom.click(dom.findButton('Send report'));
    assert.notEqual(submitted[2]?.clientReportId, submitted[1]?.clientReportId, 'changed choices are a new report');
    assert.match(dom.text(), /Report sent/);
    assert.doesNotMatch(dom.text(), /is blocked/);
  } finally {
    await dom.cleanup();
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { CloudSupportTicketInput } from '../src/features/cloud/supportClient';
import { SupportReportPermissionCard } from '../src/features/support/SupportReportPermissionCard';
import { SupportReportDialog } from '../src/features/support/SupportReportDialog';
import { SupportReportSubmissionProvider } from '../src/features/support/SupportReportSubmissionContext';
import {
  buildSupportTicketInput,
  parseSupportReportProposal,
  supportProposalSubmissionId,
  supportReportDisplayText,
} from '../src/features/support/supportReport';

const draft = {
  category: 'issue' as const,
  subject: '  Session failed  ',
  description: '  The send action never completed.  ',
  includeDiagnostics: false,
};

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const elementPrototype = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
  elementPrototype.attachEvent = function attachEvent(
    this: HTMLElement,
    name: string,
    listener: EventListener,
  ) {
    this.addEventListener(name.replace(/^on/, ''), listener);
  };
  elementPrototype.detachEvent = function detachEvent(
    this: HTMLElement,
    name: string,
    listener: EventListener,
  ) {
    this.removeEventListener(name.replace(/^on/, ''), listener);
  };
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

function setTextControlValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype = control instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  assert.ok(setter);
  setter.call(control, value);
  const event = new window.Event('propertychange', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'value' });
  control.dispatchEvent(event);
}

test('support reports cannot be built without explicit permission', () => {
  assert.throws(
    () => buildSupportTicketInput({
      draft,
      sessionId: 'session:support',
      permissionGranted: false,
      clientSubmissionId: 'desktop:one',
    }),
    /Permission is required/,
  );
});

test('a report omits diagnostics unless the user opts in', () => {
  const input = buildSupportTicketInput({
    draft,
    sessionId: 'session:support',
    permissionGranted: true,
    diagnostics: { appVersion: '0.0.1-beta.10', platform: 'desktop', osVersion: 'macOS' },
    clientSubmissionId: 'desktop:two',
  });

  assert.equal(input.subject, 'Session failed');
  assert.equal(input.description, 'The send action never completed.');
  assert.equal(input.consent.reportSubmission, true);
  assert.equal(input.consent.diagnostics, false);
  assert.equal(input.diagnostics, undefined);
});

test('diagnostics are included only after their separate opt-in', () => {
  const input = buildSupportTicketInput({
    draft: { ...draft, includeDiagnostics: true },
    sessionId: 'session:support',
    permissionGranted: true,
    diagnostics: { appVersion: '0.0.1-beta.10', platform: 'desktop', osVersion: 'macOS' },
    clientSubmissionId: 'desktop:three',
  });

  assert.equal(input.consent.diagnostics, true);
  assert.deepEqual(input.diagnostics, {
    appVersion: '0.0.1-beta.10',
    platform: 'desktop',
    osVersion: 'macOS',
  });
});

test('a structured model proposal becomes a private support draft', () => {
  const response = `I drafted the issue. Would you like me to send it to Kordi maintainers?

<kordi-support-report>
{"category":"issue","subject":"Session switching is slow","description":"Switching between two long sessions blocks interaction for several seconds."}
</kordi-support-report>`;
  const proposal = parseSupportReportProposal(response);

  assert.ok(proposal);
  assert.equal(
    proposal.displayText,
    'I drafted the issue. Would you like me to send it to Kordi maintainers?',
  );
  assert.deepEqual(proposal.draft, {
    category: 'issue',
    subject: 'Session switching is slow',
    description: 'Switching between two long sessions blocks interaction for several seconds.',
    includeDiagnostics: false,
  });
  assert.equal(
    supportReportDisplayText(`${response}\n<kordi-support-report>`),
    'I drafted the issue. Would you like me to send it to Kordi maintainers?',
  );
});

test('the current Markdown ticket format also offers explicit submission consent', () => {
  const response = `### Test Issue Ticket

**Title:** Kordi Support Routing Verification **Date:** August 4, 2026 **Type:** Test

**Description:** Verify that support requests are correctly routed to Kordi Support.

**Steps to Reproduce:**
1. Send a support request.
2. Confirm the response.

**Status:** Passed / Test Only

To submit this to a human maintainer, use the support form available in this contact.`;
  const proposal = parseSupportReportProposal(response);

  assert.ok(proposal);
  assert.equal(proposal.draft.subject, 'Kordi Support Routing Verification');
  assert.match(proposal.draft.description, /Steps to Reproduce/);
  assert.match(proposal.draft.description, /Passed \/ Test Only/);
  assert.doesNotMatch(proposal.draft.description, /use the support form/);
});

test('a legacy support refusal is recovered into an explicit permission proposal', () => {
  const response = `Thanks for the feedback! I’d restate your suggestion as:

> *Please improve or redesign the avatar border, as the current appearance is unattractive.*

I can’t create a support ticket directly from this chat. To send it to the maintainers, please submit the support form available in this contact.`;
  const proposal = parseSupportReportProposal(response);

  assert.ok(proposal);
  assert.equal(proposal.draft.category, 'feedback');
  assert.equal(proposal.draft.subject, 'Improve or redesign the avatar border');
  assert.equal(
    proposal.draft.description,
    'Please improve or redesign the avatar border, as the current appearance is unattractive.',
  );
  assert.match(proposal.displayText, /I’d restate your suggestion/);
  assert.match(proposal.displayText, /Please improve or redesign the avatar border/);
  assert.doesNotMatch(proposal.displayText, /can’t create a support ticket/);
  assert.doesNotMatch(proposal.displayText, /support form available/);
});

test('a bare legacy refusal recovers its quoted request into an approval draft', () => {
  const response = 'I can’t create or confirm a support ticket directly from this chat. To send “testtest” to a human maintainer, please submit the support form available in this contact.';
  const proposal = parseSupportReportProposal(response);

  assert.ok(proposal);
  assert.deepEqual(proposal.draft, {
    category: 'issue',
    subject: 'Testtest',
    description: 'testtest',
    includeDiagnostics: false,
  });
  assert.equal(
    proposal.displayText,
    'I drafted this support request. Review it below before anything is sent.',
  );
});

test('a legacy clearer-version redirect becomes an approval draft', () => {
  const response = `A clearer version would be:

> *An intervention at this stage could have changed the outcome, whereas the later errors may have been consequences of the initial issue.*

If you intended this as a support report, please submit it through the support form available in this contact.`;
  const proposal = parseSupportReportProposal(response);

  assert.ok(proposal);
  assert.deepEqual(proposal.draft, {
    category: 'issue',
    subject: 'An intervention at this stage could have changed the outcome',
    description: 'An intervention at this stage could have changed the outcome, whereas the later errors may have been consequences of the initial issue.',
    includeDiagnostics: false,
  });
  assert.match(proposal.displayText, /A clearer version would be/);
  assert.doesNotMatch(proposal.displayText, /support form available/);
});

test('ordinary support guidance never becomes a report proposal', () => {
  const response = 'I can help explain the support process. Send the relevant details when you are ready.';

  assert.equal(parseSupportReportProposal(response), null);
});

test('the inline permission card submits only after approval', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  const submissions: CloudSupportTicketInput[] = [];
  let lookupCalls = 0;
  let failuresRemaining = 1;
  const proposal = parseSupportReportProposal(`Draft ready.

<kordi-support-report>
{"category":"feedback","subject":"Clearer support flow","description":"Show an explicit consent card before sending."}
</kordi-support-report>`);
  assert.ok(proposal);
  const onLookup = async () => {
    lookupCalls += 1;
    return null;
  };
  const onSubmit = async (input: CloudSupportTicketInput) => {
    submissions.push(input);
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      throw new Error('Temporary support intake failure.');
    }
    return {
      ticketId: 'ticket:model-proposal',
      status: 'received' as const,
      createdAt: '2026-08-04T12:00:00.000Z',
    };
  };
  const card = (
    <SupportReportSubmissionProvider
      accountId="account:inline-consent"
      sessionId="session:support"
      onLookup={onLookup}
      onSubmit={onSubmit}
    >
      <SupportReportPermissionCard proposal={proposal} />
    </SupportReportSubmissionProvider>
  );

  try {
    await act(async () => {
      root?.render(card);
    });

    const findButton = (label: string) => Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === label);
    assert.match(host.textContent ?? '', /Send this to Kordi maintainers/);
    assert.match(host.textContent ?? '', /Chat history, files, diagnostics/);
    assert.equal(submissions.length, 0);

    await act(async () => findButton('Decline')?.click());
    assert.equal(submissions.length, 0);
    assert.match(host.textContent ?? '', /Not sent/);

    await act(async () => findButton('Review again')?.click());
    await act(async () => findButton('Approve and send')?.click());
    assert.equal(submissions.length, 1);
    assert.match(host.textContent ?? '', /Temporary support intake failure/);
    assert.ok(findButton('Approve and send'));

    await act(async () => findButton('Approve and send')?.click());
    assert.equal(submissions.length, 2);
    assert.equal(submissions[0]?.consent.reportSubmission, true);
    assert.equal(submissions[0]?.consent.diagnostics, false);
    assert.equal(submissions[0]?.diagnostics, undefined);
    assert.equal(submissions[0]?.subject, 'Clearer support flow');
    assert.equal(
      submissions[0]?.clientSubmissionId,
      supportProposalSubmissionId('session:support', proposal.draft),
    );
    assert.match(host.textContent ?? '', /Sent to Kordi maintainers/);
    assert.match(host.textContent ?? '', /ticket:model-proposal/);

    await act(async () => root?.render(<></>));
    await act(async () => root?.render(card));
    assert.match(host.textContent ?? '', /Sent to Kordi maintainers/);
    assert.match(host.textContent ?? '', /ticket:model-proposal/);
    assert.equal(findButton('Approve and send'), undefined);
    assert.equal(lookupCalls, 1);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

test('a restored proposal stays non-actionable until durable status resolves', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let resolveLookup: ((value: {
    ticketId: string;
    status: 'received';
    createdAt: string;
  }) => void) | null = null;
  const lookup = new Promise<{
    ticketId: string;
    status: 'received';
    createdAt: string;
  }>((resolve) => {
    resolveLookup = resolve;
  });
  const proposal = parseSupportReportProposal(`Draft ready.

<kordi-support-report>
{"category":"issue","subject":"Reopened approval","description":"Keep the submitted ticket terminal after reload."}
</kordi-support-report>`);
  assert.ok(proposal);

  try {
    await act(async () => {
      root?.render(
        <SupportReportSubmissionProvider
          accountId="account:durable-restore"
          sessionId="session:support"
          onLookup={() => lookup}
          onSubmit={async () => {
            throw new Error('A restored ticket must not be submitted again.');
          }}
        >
          <SupportReportPermissionCard proposal={proposal} />
        </SupportReportSubmissionProvider>,
      );
    });

    assert.match(host.textContent ?? '', /Checking submission status/);
    assert.equal(host.querySelector('button'), null);

    await act(async () => {
      resolveLookup?.({
        ticketId: 'ticket:restored',
        status: 'received',
        createdAt: '2026-08-05T12:00:00.000Z',
      });
      await lookup;
    });

    assert.match(host.textContent ?? '', /Sent to Kordi maintainers/);
    assert.match(host.textContent ?? '', /ticket:restored/);
    assert.equal(host.querySelector('button'), null);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

test('rapid duplicate approvals share one effective submission', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let submissionCalls = 0;
  let resolveSubmission: ((value: {
    ticketId: string;
    status: 'received';
    createdAt: string;
  }) => void) | null = null;
  const pendingSubmission = new Promise<{
    ticketId: string;
    status: 'received';
    createdAt: string;
  }>((resolve) => {
    resolveSubmission = resolve;
  });
  const proposal = parseSupportReportProposal(`Draft ready.

<kordi-support-report>
{"category":"feedback","subject":"Double approval","description":"Only one request should be issued."}
</kordi-support-report>`);
  assert.ok(proposal);

  try {
    await act(async () => {
      root?.render(
        <SupportReportSubmissionProvider
          accountId="account:duplicate-approval"
          sessionId="session:support"
          onLookup={async () => null}
          onSubmit={() => {
            submissionCalls += 1;
            return pendingSubmission;
          }}
        >
          <SupportReportPermissionCard proposal={proposal} />
          <SupportReportPermissionCard proposal={proposal} />
        </SupportReportSubmissionProvider>,
      );
    });
    const approvals = Array.from(host.querySelectorAll('button'))
      .filter((button) => button.textContent?.trim() === 'Approve and send');
    assert.equal(approvals.length, 2);

    await act(async () => {
      approvals[0]?.click();
      approvals[1]?.click();
    });
    assert.equal(submissionCalls, 1);
    assert.match(host.textContent ?? '', /Sending/);

    await act(async () => {
      resolveSubmission?.({
        ticketId: 'ticket:deduplicated',
        status: 'received',
        createdAt: '2026-08-05T12:00:00.000Z',
      });
      await pendingSubmission;
    });
    assert.match(host.textContent ?? '', /ticket:deduplicated/);
    assert.equal(host.querySelectorAll('button').length, 0);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

test('a changed support draft receives an independent submission identity', () => {
  const baseline = supportProposalSubmissionId('session:support', draft);
  assert.notEqual(
    supportProposalSubmissionId('session:support', {
      ...draft,
      subject: 'A different subject',
    }),
    baseline,
  );
  assert.notEqual(
    supportProposalSubmissionId('session:support', {
      ...draft,
      description: 'A different description',
    }),
    baseline,
  );
});

test('the report review explains the privacy boundary before sending', () => {
  const source = readFileSync(
    new URL('../src/features/support/SupportReportDialog.tsx', import.meta.url),
    'utf8',
  );
  const transientStyles = readFileSync(
    new URL('../src/styles/transient-surfaces.css', import.meta.url),
    'utf8',
  );

  assert.match(source, /Nothing is sent until you review and approve it/);
  assert.match(source, /I allow Kordi to send the report shown above to Kordi Support/);
  assert.match(source, /No chat transcript, files, provider credentials, or unrelated conversations are included/);
  assert.match(source, /disabled=\{!permissionGranted \|\| busy\}/);
  assert.match(source, /max-h-\[calc\(100dvh-1\.5rem\)\]/);
  assert.match(source, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(source, /AppDialogTitle id="support-report-title" className="text-\[14px\] leading-5"/);
  assert.match(source, /grid gap-1 text-\[11px\] font-medium/);
  assert.match(source, /h-9 w-full[^\n]+text-\[12px\]/);
  assert.match(source, /app-support-report-action/);
  assert.match(transientStyles, /\.app-transient-surface \.app-support-report-action\s*\{[^}]*font-size: 0\.625rem;/s);
  assert.match(source, /peer-checked:bg-\[color:var\(--app-sidebar-accent\)\]/);
  assert.match(source, /peer-focus-visible:outline-\[color:var\(--app-transient-focus-ring\)\]/);
  assert.doesNotMatch(source, /accent-\[color:var/);
  assert.doesNotMatch(source, /app-transient-row flex cursor-pointer/);
});

test('report fields remain interactive after React releases each change event', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);

  try {
    await act(async () => {
      root?.render(
        <SupportReportDialog
          sessionId="session:support"
          onDismiss={() => undefined}
          onSubmit={async () => ({
            ticketId: 'ticket:one',
            status: 'received',
            createdAt: '2026-08-04T12:00:00.000Z',
          })}
        />,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const category = dialog.querySelector('select');
    const subject = dialog.querySelector('input:not([type="checkbox"])');
    const description = dialog.querySelector('textarea');
    const diagnostics = dialog.querySelector('input[type="checkbox"]');
    assert.ok(category);
    assert.ok(subject instanceof installed.dom.window.HTMLInputElement);
    assert.ok(description instanceof installed.dom.window.HTMLTextAreaElement);
    assert.ok(diagnostics instanceof installed.dom.window.HTMLInputElement);

    await act(async () => {
      category.value = 'feedback';
      category.dispatchEvent(new installed.dom.window.Event('change', { bubbles: true }));
      subject.focus();
      setTextControlValue(subject, 'Compact report form');
      description.focus();
      setTextControlValue(description, 'The report dialog must remain visible.');
      diagnostics.click();
    });

    assert.equal(category.value, 'feedback');
    assert.equal(subject.value, 'Compact report form');
    assert.equal(description.value, 'The report dialog must remain visible.');
    assert.equal(diagnostics.checked, true);

    const reviewButton = Array.from(dialog.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Review report');
    assert.ok(reviewButton);
    assert.equal(reviewButton.disabled, false);
    await act(async () => reviewButton.click());
    assert.match(dialog.textContent ?? '', /Feedback/);
    assert.match(dialog.textContent ?? '', /Compact report form/);
    assert.match(dialog.textContent ?? '', /The report dialog must remain visible/);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

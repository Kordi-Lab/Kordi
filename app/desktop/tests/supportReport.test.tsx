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

test('the inline permission card submits only after approval', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  const submissions: CloudSupportTicketInput[] = [];
  const proposal = parseSupportReportProposal(`Draft ready.

<kordi-support-report>
{"category":"feedback","subject":"Clearer support flow","description":"Show an explicit consent card before sending."}
</kordi-support-report>`);
  assert.ok(proposal);

  try {
    await act(async () => {
      root?.render(
        <SupportReportSubmissionProvider
          sessionId="session:support"
          onSubmit={async (input) => {
            submissions.push(input);
            return {
              ticketId: 'ticket:model-proposal',
              status: 'received',
              createdAt: '2026-08-04T12:00:00.000Z',
            };
          }}
        >
          <SupportReportPermissionCard proposal={proposal} />
        </SupportReportSubmissionProvider>,
      );
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
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildSupportTicketInput } from '../src/features/support/supportReport';

const draft = {
  category: 'issue' as const,
  subject: '  Session failed  ',
  description: '  The send action never completed.  ',
  includeDiagnostics: false,
};

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

test('the report review explains the privacy boundary before sending', () => {
  const source = readFileSync(
    new URL('../src/features/support/SupportReportDialog.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /Nothing is sent until you review and approve it/);
  assert.match(source, /I allow Kordi to send the report shown above to Kordi Support/);
  assert.match(source, /No chat transcript, files, provider credentials, or unrelated conversations are included/);
  assert.match(source, /disabled=\{!permissionGranted \|\| busy\}/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownContent } from '../src/kordi-app/components';
import {
  applyConnectorsSettingsTarget,
  connectorsSettingsLinkPrefix,
  openConnectorsSettingsLink,
  parseConnectorsSettingsLink,
  takePendingConnectorsProvider,
  type ConnectorsSettingsTarget,
} from '../src/features/connectors/connectorsSettingsLink';
import { ToolApprovalCard } from '../src/features/connectors/ToolApprovalPrompts';
import {
  applyToolApprovalEvent,
  parseToolApprovalPrompt,
  toolApprovalDetails,
  toolApprovalHeadline,
} from '../src/features/connectors/toolApprovalModel';

test('connectors deep links map to the settings tab and provider', () => {
  assert.deepEqual(parseConnectorsSettingsLink('kordi://settings/connectors?provider=gmail'), { tab: 'connectors', providerId: 'gmail' });
  assert.deepEqual(parseConnectorsSettingsLink('kordi://settings/connectors?provider=google_calendar'), { tab: 'connectors', providerId: 'google_calendar' });
  assert.deepEqual(parseConnectorsSettingsLink('kordi://settings/connectors/'), { tab: 'connectors', providerId: null });
  assert.deepEqual(parseConnectorsSettingsLink('kordi://settings/connectors?provider=outlook'), { tab: 'connectors', providerId: null });
  for (const href of [
    'https://settings/connectors?provider=gmail',
    'kordi://settings/profile',
    'kordi://settings/connectors-evil',
    'kordi://user:pass@settings/connectors',
    'javascript:alert(1)',
    '',
  ]) {
    assert.equal(parseConnectorsSettingsLink(href), null, href);
  }
});

test('clicking a connectors link opens the dialog tab with the provider selected', () => {
  const dispatched: ConnectorsSettingsTarget[] = [];
  let prevented = false;
  const handled = openConnectorsSettingsLink(
    { preventDefault: () => { prevented = true; }, button: 0 },
    'kordi://settings/connectors?provider=github',
    (target) => dispatched.push(target),
  );
  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.deepEqual(dispatched, [{ tab: 'connectors', providerId: 'github' }]);

  const opened: string[] = [];
  applyConnectorsSettingsTarget(dispatched[0], (tab) => opened.push(tab));
  assert.deepEqual(opened, ['connectors']);
  assert.equal(takePendingConnectorsProvider(), 'github');
  assert.equal(takePendingConnectorsProvider(), null, 'the provider is read once');

  assert.equal(openConnectorsSettingsLink({ preventDefault: () => {}, button: 1 }, 'kordi://settings/connectors', () => assert.fail()), false);
  assert.equal(openConnectorsSettingsLink({ preventDefault: () => {} }, 'https://example.com', () => assert.fail()), false);
});

test('agent messages render the connect link as an in-app settings link', () => {
  assert.deepEqual(connectorsSettingsLinkPrefix('[Connect Slack](kordi://settings/connectors?provider=slack) now'), {
    href: 'kordi://settings/connectors?provider=slack',
    label: 'Connect Slack',
    matchedLength: 59,
  });
  assert.equal(connectorsSettingsLinkPrefix('kordi://settings/connectors?provider=slack.')?.href, 'kordi://settings/connectors?provider=slack');
  const markup = renderToStaticMarkup(createElement(MarkdownContent, {
    text: 'Open Connectors settings to connect Gmail: [Connect Gmail](kordi://settings/connectors?provider=gmail)',
  }));
  assert.match(markup, /data-connectors-settings-link="true"/);
  assert.match(markup, /href="kordi:\/\/settings\/connectors\?provider=gmail"/);
  assert.match(markup, />Connect Gmail</);
  assert.doesNotMatch(markup, /target="_blank"/);
});

test('the approval card asks before an agent acts through a connector', () => {
  const prompt = parseToolApprovalPrompt({
    requestId: 'req-1',
    tool: 'gmail.send',
    summary: 'Send an email.',
    connector: 'gmail',
    args: { to: 'ana@example.com', subject: 'Lunch' },
  });
  assert.ok(prompt);
  assert.equal(toolApprovalHeadline(prompt), 'Your agent wants to send an email in Gmail.');
  assert.equal(toolApprovalHeadline({ tool: 'calendar.respond', summary: '', connector: 'calendar' }), 'Your agent wants to use calendar.respond in Google Calendar.');
  assert.equal(toolApprovalDetails({}), null);
  assert.equal(toolApprovalDetails({ text: 'x'.repeat(400) })?.length, 160);
  assert.equal(parseToolApprovalPrompt({ tool: 'gmail.send' }), null);

  const markup = renderToStaticMarkup(createElement(ToolApprovalCard, { prompt, onRespond: () => {} }));
  assert.match(markup, /data-tool-approval-card="true"/);
  assert.match(markup, /Your agent wants to send an email in Gmail\./);
  assert.match(markup, />Allow</);
  assert.match(markup, />Not now</);
  assert.match(markup, /ana@example\.com/);

  let pending = applyToolApprovalEvent([], { kind: 'request', prompt });
  pending = applyToolApprovalEvent(pending, { kind: 'request', prompt });
  assert.equal(pending.length, 1, 'a repeated event does not add a second card');
  assert.deepEqual(applyToolApprovalEvent(pending, { kind: 'resolved', requestId: 'req-1' }), []);
});

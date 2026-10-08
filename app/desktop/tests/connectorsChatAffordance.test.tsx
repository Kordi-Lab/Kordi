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
  parsePendingToolApprovals,
  parseToolApprovalPrompt,
  toolApprovalHeadline,
  toolApprovalSource,
  toolApprovalView,
  type ToolApprovalPrompt,
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

test('a model link label is capped at 80 characters', () => {
  const long = 'Connect '.repeat(20).trim();
  const match = connectorsSettingsLinkPrefix(`[${long}](kordi://settings/connectors?provider=slack)`);
  assert.ok(match);
  assert.equal(Array.from(match.label).length, 80);
  assert.ok(match.label.endsWith('…'));
  assert.equal(match.matchedLength, long.length + 46);
});

function prompt(tool: string, args: unknown, extra: Partial<ToolApprovalPrompt> = {}): ToolApprovalPrompt {
  const parsed = parseToolApprovalPrompt({ requestId: `req-${tool}`, tool, summary: 'Act.', connector: 'gmail', args, ...extra });
  assert.ok(parsed);
  return parsed;
}

test('the approval card asks before an agent acts through a connector', () => {
  const parsed = parseToolApprovalPrompt({
    requestId: 'req-1',
    tool: 'gmail_send',
    summary: 'Send an email.',
    connector: 'gmail',
    args: { to: ['ana@example.com'], subject: 'Lunch' },
    sessionId: 'session:dm:1',
    conversationTitle: 'Trip planning',
    agentName: 'Kordi',
  });
  assert.ok(parsed);
  assert.equal(toolApprovalHeadline(parsed), 'Kordi wants to send an email in Gmail.');
  assert.equal(toolApprovalHeadline({ tool: 'calendar.respond', summary: '', connector: 'calendar' }), 'Your agent wants to use calendar.respond in Google Calendar.');
  assert.equal(toolApprovalSource(parsed), 'From “Trip planning”');
  assert.equal(toolApprovalSource({ conversationTitle: null, sessionId: 'session:dm:2' }), 'From conversation session:dm:2');
  assert.equal(parseToolApprovalPrompt({ tool: 'gmail_send' }), null);

  const markup = renderToStaticMarkup(createElement(ToolApprovalCard, { prompt: parsed, onRespond: () => {} }));
  assert.match(markup, /data-tool-approval-card="true"/);
  assert.match(markup, /Kordi wants to send an email in Gmail\./);
  assert.match(markup, /From “Trip planning”/);
  assert.match(markup, />Allow</);
  assert.match(markup, />Not now</);
  assert.match(markup, /ana@example\.com/);
  assert.doesNotMatch(markup, /truncate/);

  let pending = applyToolApprovalEvent([], { kind: 'request', prompt: parsed });
  pending = applyToolApprovalEvent(pending, { kind: 'request', prompt: parsed });
  assert.equal(pending.length, 1, 'a repeated event does not add a second card');
  assert.deepEqual(applyToolApprovalEvent(pending, { kind: 'resolved', requestId: 'req-1' }), []);
  assert.deepEqual(parsePendingToolApprovals([{ requestId: 'req-1', tool: 'gmail_send' }, { bad: true }, null]).map((item) => item.requestId), ['req-1']);
  assert.deepEqual(parsePendingToolApprovals(null), []);
});

test('the approval card shows every recipient, the subject, and the whole body', () => {
  const to = Array.from({ length: 12 }, (_, index) => `person${index}@example.com`);
  const body = `${'Line of the message. '.repeat(40)}\nSecond paragraph.`;
  const view = toolApprovalView(prompt('gmail_send', { to, cc: ['cc@example.com'], bcc: ['hidden@example.com'], subject: 'A subject that is longer than any single line would allow on the card', body }));
  assert.deepEqual(view.fields, [
    { label: 'To', value: to.join(', ') },
    { label: 'Cc', value: 'cc@example.com' },
    { label: 'Bcc', value: 'hidden@example.com' },
    { label: 'Subject', value: 'A subject that is longer than any single line would allow on the card' },
  ]);
  assert.deepEqual(view.blocks, [{ label: 'Message', text: body }]);
  const markup = renderToStaticMarkup(createElement(ToolApprovalCard, { prompt: prompt('gmail_send', { to, bcc: ['hidden@example.com'], subject: 'S', body }), onRespond: () => {} }));
  for (const address of [...to, 'hidden@example.com']) assert.ok(markup.includes(address), address);
  assert.match(markup, /Second paragraph\./);
  assert.match(markup, /overflow-auto/);
  assert.deepEqual(toolApprovalView(prompt('gmail_send', { body: 'Hi' })).fields, [
    { label: 'To', value: 'No recipients' },
    { label: 'Subject', value: '(no subject)' },
  ]);
});

test('calendar, Slack, and GitHub cards name what they change', () => {
  const event = toolApprovalView(prompt('calendar_create_event', {
    summary: 'Design review', start: '2026-10-08T10:00:00Z', end: '2026-10-08T11:00:00Z', timeZone: 'UTC',
    attendees: ['a@example.com', 'b@example.com', 'c@example.com'], description: 'Agenda',
  }));
  assert.deepEqual(event.fields, [
    { label: 'Time', value: '2026-10-08T10:00:00Z – 2026-10-08T11:00:00Z (UTC)' },
    { label: 'Title', value: 'Design review' },
    { label: 'Attendees', value: 'a@example.com, b@example.com, c@example.com' },
  ]);
  assert.deepEqual(event.blocks, [{ label: 'Description', text: 'Agenda' }]);
  const respond = toolApprovalView(prompt('calendar_respond', { eventId: 'evt_1', response: 'declined', summary: 'Standup', start: '2026-10-08T09:00:00Z', attendees: ['x@example.com'] }));
  assert.deepEqual(respond.fields, [
    { label: 'Time', value: '2026-10-08T09:00:00Z' },
    { label: 'Title', value: 'Standup' },
    { label: 'Attendees', value: 'x@example.com' },
    { label: 'Response', value: 'declined' },
    { label: 'Event', value: 'evt_1' },
  ]);
  const slack = toolApprovalView(prompt('slack_post', { channel: 'C0123', text: 'Shipping today.\nThanks all.' }));
  assert.deepEqual(slack.fields, [{ label: 'Channel', value: 'C0123' }]);
  assert.deepEqual(slack.blocks, [{ label: 'Message', text: 'Shipping today.\nThanks all.' }]);
  const github = toolApprovalView(prompt('github_comment', { owner: 'kordi', repo: 'app', number: 42, body: 'LGTM' }));
  assert.deepEqual(github.fields, [{ label: 'Repository', value: 'kordi/app' }, { label: 'Number', value: '42' }]);
  assert.deepEqual(github.blocks, [{ label: 'Comment', text: 'LGTM' }]);
  // An argument the card has no label for is still shown.
  const extra = toolApprovalView(prompt('slack_post', { channel: 'C1', text: 'Hi', unfurl: true }));
  assert.deepEqual(extra.blocks.at(-1), { label: 'Other details', text: 'unfurl: true' });
});

test('unknown act tools list every argument, and shortened requests say so', () => {
  const view = toolApprovalView(prompt('notion_update', { page: 'Roadmap', patch: { status: 'done' }, tags: ['a', 'b'] }));
  assert.deepEqual(view.fields, []);
  assert.deepEqual(view.blocks, [{ label: 'Details', text: 'page: Roadmap\npatch: {\n  "status": "done"\n}\ntags: a, b' }]);
  const truncated = prompt('gmail_send', { to: ['a@example.com'], subject: 'S', body: 'x…' }, { argsTruncated: true });
  assert.equal(toolApprovalView(truncated).truncated, true);
  const markup = renderToStaticMarkup(createElement(ToolApprovalCard, { prompt: truncated, onRespond: () => {} }));
  assert.match(markup, /data-tool-approval-truncated="true"/);
  assert.deepEqual(toolApprovalView(prompt('gmail_send', 'raw text')).blocks, [{ label: 'Request', text: 'raw text' }]);
});

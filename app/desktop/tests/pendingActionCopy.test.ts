import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calendarWindowLabel,
  formatPendingTime,
  pendingActionAnnouncement,
  pendingActionCopy,
  pendingActionErrorText,
} from '../src/features/agentTrust/pendingActionCopy';
import { newPendingActionsAnnouncement } from '../src/features/agentTrust/usePendingAgentActions';
import type { PendingAgentAction, PendingAgentActionKind } from '../src/features/cloud/agentTrustTypes';

const FORMAT = { locale: 'en-US', timeZone: 'UTC' };

function action(kind: PendingAgentActionKind, subject: Record<string, unknown>, displayName: string | null = 'PiP'): PendingAgentAction {
  return {
    actionId: `action-${kind}`,
    kind,
    sessionId: 'session:group:weekend',
    conversationId: 'conversation-1',
    status: 'pending',
    createdAt: '2026-10-01T10:00:00Z',
    expiresAt: '2026-10-01T10:10:00Z',
    proposedBy: { accountId: 'acct_agent', displayName, kind: kind === 'calendar_disclosure' ? 'agent' : 'pip' },
    subject,
  };
}

test('times use local dates with a time zone label, like plan cards', () => {
  assert.equal(formatPendingTime('2026-10-02T18:30:00Z', FORMAT), 'Fri, Oct 2 · 6:30 PM UTC');
  assert.equal(formatPendingTime('2026-10-02T18:30:00Z', { locale: 'en-US', timeZone: 'America/Los_Angeles' }), 'Fri, Oct 2 · 11:30 AM PDT');
  assert.equal(formatPendingTime('2026-10-02', { locale: 'en-US', timeZone: 'Asia/Tokyo' }), 'Fri, Oct 2', 'a date alone never shifts days');
  assert.equal(formatPendingTime('next week', FORMAT), 'next week', 'unparsed values are shown as given');
  assert.equal(formatPendingTime('', FORMAT), null);
  assert.equal(formatPendingTime(42, FORMAT), null);
});

test('calendar windows cover both ends, one end, and no ends', () => {
  assert.equal(calendarWindowLabel('2026-10-02', '2026-10-04', FORMAT), 'Fri, Oct 2 – Sun, Oct 4');
  assert.equal(calendarWindowLabel('2026-10-02', null, FORMAT), 'from Fri, Oct 2');
  assert.equal(calendarWindowLabel(undefined, '2026-10-04', FORMAT), 'until Sun, Oct 4');
  assert.equal(calendarWindowLabel(null, '  ', FORMAT), 'all dates');
});

test('calendar sharing names the agent, the window, and the 10 minute grant', () => {
  const copy = pendingActionCopy(action('calendar_disclosure', {
    agentName: 'Atlas', startAt: '2026-10-02', endAt: '2026-10-03',
  }), FORMAT);
  assert.equal(copy.title, 'Share your calendar in this chat?');
  assert.equal(copy.body, 'Atlas wants to read your saved Kordi calendar for Fri, Oct 2 – Sat, Oct 3 and may summarize it for everyone here.');
  assert.equal(copy.footnote, 'If you allow this, Atlas can read these dates again in this chat for the next 10 minutes.');
  assert.deepEqual([copy.approveLabel, copy.declineLabel], ['Allow', 'Don\'t allow']);
  assert.equal(copy.approveName, 'Allow sharing your calendar');
  assert.equal(copy.declineName, 'Don\'t allow sharing your calendar');

  const unnamed = pendingActionCopy(action('calendar_disclosure', {}, null), FORMAT);
  assert.equal(unnamed.body, 'Your agent wants to read your saved Kordi calendar for all dates and may summarize it for everyone here.');
  const proposer = pendingActionCopy(action('calendar_disclosure', { startAt: '2026-10-02' }, 'Juniper'), FORMAT);
  assert.match(proposer.body, /^Juniper wants to read your saved Kordi calendar for from Fri, Oct 2 /);
});

test('PiP answers read as suggestions the member confirms', () => {
  const yes = pendingActionCopy(action('plan_rsvp', { title: 'Lunch', startAt: '2026-10-03T12:30:00Z', rsvp: 'yes' }), FORMAT);
  assert.equal(yes.title, 'PiP noted you\'re in');
  assert.equal(yes.body, 'From your message, PiP thinks you can make “Lunch” on Sat, Oct 3 · 12:30 PM UTC. Confirm so the plan shows your answer.');
  assert.deepEqual([yes.approveLabel, yes.declineLabel, yes.footnote], ['Confirm', 'Not right', null]);
  assert.equal(yes.approveName, 'Confirm your answer for Lunch');

  const no = pendingActionCopy(action('plan_rsvp', { title: 'Lunch', rsvp: 'no' }), FORMAT);
  assert.equal(no.title, 'PiP noted you can\'t make it');
  assert.equal(no.body, 'From your message, PiP thinks you can\'t make “Lunch”. Confirm so the plan shows your answer.');

  const vote = pendingActionCopy(action('plan_vote', { title: 'Lunch', optionId: 'o1', optionLabel: 'Saturday' }), FORMAT);
  assert.equal(vote.title, 'PiP noted your choice');
  assert.equal(vote.body, 'From your message, PiP thinks you prefer “Saturday” for “Lunch”. Confirm to add your vote.');
  assert.deepEqual([vote.approveLabel, vote.declineLabel], ['Vote', 'Not right']);
  assert.equal(vote.approveName, 'Vote for Saturday');
});

test('plan decisions say what confirming, canceling, or reopening does', () => {
  const confirm = pendingActionCopy(action('plan_confirm', {
    title: 'Lunch', revision: 3, startAt: '2026-10-03T12:30:00Z', location: 'Cafe Rio',
  }), FORMAT);
  assert.equal(confirm.title, 'Confirm this plan?');
  assert.equal(confirm.body, 'PiP thinks the group settled on “Lunch” on Sat, Oct 3 · 12:30 PM UTC at Cafe Rio. Confirming adds it to the Kordi calendar of everyone who said they\'re in.');
  assert.deepEqual([confirm.approveLabel, confirm.declineLabel], ['Confirm plan', 'Not yet']);
  const bare = pendingActionCopy(action('plan_confirm', { revision: 1 }), FORMAT);
  assert.equal(bare.body, 'PiP thinks the group settled on “this plan”. Confirming adds it to the Kordi calendar of everyone who said they\'re in.');

  const cancel = pendingActionCopy(action('plan_cancel', { title: 'Lunch', revision: 3, reason: 'Rain' }), FORMAT);
  assert.equal(cancel.title, 'Cancel this plan?');
  assert.equal(cancel.body, 'PiP thinks “Lunch” is off: “Rain”. Canceling removes it from everyone\'s Kordi calendar.');
  assert.deepEqual([cancel.approveLabel, cancel.declineLabel], ['Cancel plan', 'Keep plan']);
  assert.equal(pendingActionCopy(action('plan_cancel', { title: 'Lunch' }), FORMAT).body,
    'PiP thinks “Lunch” is off. Canceling removes it from everyone\'s Kordi calendar.');

  const reopen = pendingActionCopy(action('plan_reopen', { title: 'Lunch', revision: 4, reason: 'Ana is sick' }), FORMAT);
  assert.equal(reopen.title, 'Reopen this plan?');
  assert.equal(reopen.body, 'PiP thinks “Lunch” may no longer stand: “Ana is sick”. Reopening removes it from calendars until someone confirms it again.');
  assert.deepEqual([reopen.approveLabel, reopen.declineLabel], ['Reopen', 'Keep as is']);
});

test('every kind gives both buttons distinct accessible names', () => {
  const kinds: PendingAgentActionKind[] = ['calendar_disclosure', 'plan_rsvp', 'plan_vote', 'plan_confirm', 'plan_cancel', 'plan_reopen'];
  for (const kind of kinds) {
    const copy = pendingActionCopy(action(kind, { title: 'Lunch', optionLabel: 'Saturday' }), FORMAT);
    assert.ok(copy.approveName && copy.declineName, kind);
    assert.notEqual(copy.approveName, copy.declineName, kind);
  }
});

test('errors and announcements use the agreed wording', () => {
  assert.equal(pendingActionErrorText('plan_changed'), 'This plan changed. Check the card and try again.');
  assert.equal(pendingActionErrorText('agent_action_closed'), 'This request is no longer waiting. Ask again if you still need it.');
  assert.equal(pendingActionErrorText('plan_card_forbidden'), 'Couldn\'t save your answer. Try again.');
  assert.equal(pendingActionErrorText(null), 'Couldn\'t save your answer. Try again.');

  const calendar = action('calendar_disclosure', {});
  const rsvp = action('plan_rsvp', { title: 'Lunch' });
  assert.equal(pendingActionAnnouncement(calendar, 'approve'), 'Calendar sharing allowed.');
  assert.equal(pendingActionAnnouncement(calendar, 'decline'), 'Calendar sharing declined.');
  assert.equal(pendingActionAnnouncement(rsvp, 'approve'), 'Answer saved.');
  assert.equal(pendingActionAnnouncement(rsvp, 'decline'), 'Suggestion dismissed.');

  assert.equal(newPendingActionsAnnouncement([calendar]), 'Waiting for you: Share your calendar in this chat?');
  assert.equal(newPendingActionsAnnouncement([calendar, rsvp]), '2 requests are waiting for you.');
  assert.equal(newPendingActionsAnnouncement([]), '');
});

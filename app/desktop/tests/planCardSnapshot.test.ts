import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizePlanCardSnapshot } from '../src/features/cloud/planCardSnapshot';

test('plan card participants carry their profile avatar for faces instead of initials', () => {
  const card = normalizePlanCardSnapshot({
    eventId: 'plan_1',
    title: 'Lunch',
    state: 'polling',
    revision: 1,
    participants: [
      { participantId: 'acct_a', displayName: 'Ada', organizer: true, rsvp: 'yes', avatarUrl: 'https://cdn.example/a.png' },
      { participantId: 'acct_b', displayName: 'Bob', organizer: false, rsvp: 'pending' },
    ],
  });

  assert.equal(card?.participants[0].avatarUrl, 'https://cdn.example/a.png');
  assert.equal(card?.participants[1].avatarUrl, null);
});

test('the built-in agent is not a plan participant', () => {
  const card = normalizePlanCardSnapshot({
    eventId: 'plan_1',
    title: 'Lunch',
    state: 'polling',
    revision: 1,
    participants: [
      { participantId: 'acct_a', displayName: 'Ada', organizer: true, rsvp: 'yes' },
      { participantId: 'acct_kordi_pip', displayName: 'PiP', organizer: false, rsvp: 'pending' },
    ],
  });

  assert.deepEqual(card?.participants.map((participant) => participant.participantId), ['acct_a']);
});

test('a blank or non-string avatar url falls back to initials', () => {
  const card = normalizePlanCardSnapshot({
    eventId: 'plan_1',
    title: 'Lunch',
    state: 'polling',
    revision: 1,
    participants: [
      { participantId: 'acct_a', displayName: 'Ada', organizer: true, rsvp: 'yes', avatarUrl: '   ' },
      { participantId: 'acct_b', displayName: 'Bob', organizer: false, rsvp: 'pending', avatarUrl: 42 },
    ],
  });

  assert.equal(card?.participants[0].avatarUrl, null);
  assert.equal(card?.participants[1].avatarUrl, null);
});

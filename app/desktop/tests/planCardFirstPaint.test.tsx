import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { __setSessionBackendForTests, loadSession, type StoredSession } from '../src/features/cloud/session';
import { PlanCardContent } from '../src/kordi-app/components/planCard';
import type { MessagePlanCard } from '../src/kordi-app/types';

const card: MessagePlanCard = {
  eventId: 'plan-first-paint', revision: 2, view: 'event', state: 'awaiting_confirmation', title: 'Meet',
  startAt: '2030-10-27T03:00:00Z', endAt: '2030-10-27T03:30:00Z', unresolvedFields: [], options: [],
  participants: [
    { participantId: 'acct_peer', displayName: 'Peer', organizer: true, rsvp: 'yes' },
    { participantId: 'acct_me', displayName: 'Me', organizer: false, rsvp: 'pending' },
  ],
};

test('a plan card paints its answer buttons in the first render once the session is loaded', async (t) => {
  const session: StoredSession = { token: 'synthetic-token', accountId: 'acct_me', expiresAt: '2099-01-01T00:00:00Z' };
  __setSessionBackendForTests({ load: async () => session, save: async () => undefined, clear: async () => undefined });
  t.after(() => __setSessionBackendForTests(null));
  await loadSession();
  // Static rendering runs no effects: this is the card's first paint. It must
  // not grow a row of buttons a frame later and move the transcript.
  const markup = renderToStaticMarkup(createElement(PlanCardContent, { card }));
  assert.match(markup, /Can&#x27;t make it/);
  assert.match(markup, /I&#x27;m in/);
});

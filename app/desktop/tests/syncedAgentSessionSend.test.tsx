import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AGENT_SESSION_NOT_ON_THIS_MAC_DETAIL,
  fetchMaterializedLocalChatTarget,
} from '../src/features/chat/messageActions/localAgentSessionTarget';
import { MessageBubble } from '../src/kordi-app/components/transcript';
import type { DesktopChatState, Message } from '../src/kordi-app/types';

const SYNCED_SESSION_ID = 'synced-cloud-session';

function runtimeState(sessionId: string) {
  return { activeSessionId: sessionId, activeSession: { id: sessionId } } as unknown as DesktopChatState;
}

// The native runtime answers with its most recent local session when the
// requested one has no transcript on this Mac.
const runtimeWithoutSyncedSession = async () => runtimeState('most-recent-local-session');

test('a Kordi Cloud send to a session synced from another device does not need its local transcript', async () => {
  const materialized = await fetchMaterializedLocalChatTarget(SYNCED_SESSION_ID, null, {
    runsOnKordiCloud: true,
    fetchState: runtimeWithoutSyncedSession,
  });
  assert.equal(materialized, null);
});

test('a local send to a session without a local transcript fails with an actionable reason', async () => {
  await assert.rejects(
    fetchMaterializedLocalChatTarget(SYNCED_SESSION_ID, null, { fetchState: runtimeWithoutSyncedSession }),
    (error: unknown) => error instanceof Error && error.message === AGENT_SESSION_NOT_ON_THIS_MAC_DETAIL,
  );
  assert.doesNotMatch(AGENT_SESSION_NOT_ON_THIS_MAC_DETAIL, /try again/i);
});

test('a session the runtime can load is materialized for either route', async () => {
  const fetchState = async (sessionId: string) => runtimeState(sessionId);
  for (const runsOnKordiCloud of [false, true]) {
    const materialized = await fetchMaterializedLocalChatTarget(SYNCED_SESSION_ID, null, { runsOnKordiCloud, fetchState });
    assert.equal(materialized?.activeSessionId, SYNCED_SESSION_ID);
  }
  let fetched = false;
  const current = await fetchMaterializedLocalChatTarget(SYNCED_SESSION_ID, runtimeState(SYNCED_SESSION_ID), {
    fetchState: async (sessionId) => { fetched = true; return runtimeState(sessionId); },
  });
  assert.equal(current, null);
  assert.equal(fetched, false);
});

test('a short failed message of my own shows its failure reason next to the red marker', () => {
  const message: Message = {
    role: 'user',
    sender: 'Me',
    senderType: 'human',
    isOwnMessage: true,
    text: 'short question',
    time: '11:51',
    statusChips: ['failed'],
    detail: 'The failure reason',
  };
  const markup = renderToStaticMarkup(createElement(MessageBubble, { msg: message }));
  assert.match(markup, /data-message-delivery-status="failed"/);
  assert.match(markup, /app-message-failure-detail[^>]*>The failure reason</);

  const sentMarkup = renderToStaticMarkup(createElement(MessageBubble, {
    msg: { ...message, statusChips: ['sent'], detail: undefined },
  }));
  assert.match(sentMarkup, /app-message-compact-footer/, 'a sent short message keeps its inline footer');
});

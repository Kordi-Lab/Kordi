import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import type { AgentTrustApi, AgentTrustCalls } from '../src/features/agentTrust/agentTrustApi';
import { AGENT_ACTION_UPDATED_EVENT, dispatchWindowEvent } from '../src/features/agentTrust/agentTrustEvents';
import { sessionCanHavePendingActions } from '../src/features/agentTrust/usePendingAgentActions';
import type {
  AgentActionDecision,
  PendingAgentAction,
  PendingAgentActionKind,
} from '../src/features/cloud/agentTrustTypes';
import { CloudAuthError } from '../src/features/cloud/cloudAuthError';
import { PendingAgentActionsBanner } from '../src/kordi-app/components/pendingAgentActionsBanner';
import { flushReactUpdates, installDom } from './helpers/transcriptAttachmentDom';

const SESSION = 'session:group:weekend';
const FORMAT = { locale: 'en-US', timeZone: 'UTC' };
const LATER = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function action(id: string, kind: PendingAgentActionKind, subject: Record<string, unknown>, overrides: Partial<PendingAgentAction> = {}): PendingAgentAction {
  return {
    actionId: id,
    kind,
    sessionId: SESSION,
    conversationId: 'conversation-1',
    status: 'pending',
    createdAt: '2026-10-01T10:00:00Z',
    expiresAt: LATER,
    proposedBy: { accountId: 'acct_agent', displayName: kind === 'calendar_disclosure' ? 'Atlas' : 'PiP', kind: kind === 'calendar_disclosure' ? 'agent' : 'pip' },
    subject,
    ...overrides,
  };
}

const calendar = action('a-calendar', 'calendar_disclosure', { agentName: 'Atlas', startAt: '2026-10-02', endAt: '2026-10-03' });
const rsvp = action('a-rsvp', 'plan_rsvp', { title: 'Lunch', rsvp: 'yes' });

type Decision = { actionId: string; decision: AgentActionDecision };

function fakeApi(initial: PendingAgentAction[], decideImpl?: (decision: Decision) => Promise<void>) {
  let current = initial;
  const lists: Array<string | null | undefined> = [];
  const decisions: Decision[] = [];
  const calls = {
    listAgentActions: async (_token: string, sessionId?: string | null) => {
      lists.push(sessionId);
      return current;
    },
    decideAgentAction: async (_token: string, actionId: string, decision: AgentActionDecision) => {
      decisions.push({ actionId, decision });
      if (decideImpl) await decideImpl({ actionId, decision });
      current = current.filter((item) => item.actionId !== actionId);
      return { action: null, planCard: null };
    },
  } as unknown as AgentTrustCalls;
  const api: AgentTrustApi = { session: async () => ({ token: 'token', accountId: 'acct_me' }), calls };
  return {
    api,
    lists,
    decisions,
    setActions(next: PendingAgentAction[]) { current = next; },
  };
}

async function render(api: AgentTrustApi, sessionId: string = SESSION) {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(PendingAgentActionsBanner, { sessionId, api, format: FORMAT }));
  });
  await flushReactUpdates();
  return {
    host,
    region: () => host.querySelector('[role="region"][aria-label="Waiting for you"]'),
    live: () => host.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '',
    alert: () => host.querySelector('[role="alert"]')?.textContent ?? null,
    button: (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`),
    items: () => [...host.querySelectorAll('[data-pending-agent-action]')].map((item) => item.getAttribute('data-pending-agent-action')),
    async click(element: Element | null) {
      assert.ok(element, 'element exists');
      await act(async () => { (element as HTMLElement).click(); });
      await flushReactUpdates();
    },
    async dispatch(run: () => void) {
      await act(async () => { run(); });
      await flushReactUpdates();
    },
    async close() { await act(async () => root.unmount()); installed.restore(); },
  };
}

test('only chats shared with other people can have actions', async () => {
  assert.equal(sessionCanHavePendingActions('session:group:abc'), true);
  assert.equal(sessionCanHavePendingActions('session:direct-person:a:b'), true);
  assert.equal(sessionCanHavePendingActions('session:direct-agent:x'), false);
  assert.equal(sessionCanHavePendingActions(null), false);

  const fake = fakeApi([calendar]);
  const view = await render(fake.api, 'session:direct-agent:own');
  try {
    assert.equal(view.region(), null);
    assert.deepEqual(fake.lists, [], 'nothing is loaded for private agent chats');
  } finally {
    await view.close();
  }
});

test('the banner is a labeled region with each action, its copy, and named buttons', async () => {
  const fake = fakeApi([
    calendar,
    rsvp,
    action('a-old', 'plan_vote', { title: 'Lunch', optionLabel: 'Sat' }, { expiresAt: '2020-01-01T00:00:00Z' }),
    action('a-done', 'plan_cancel', { title: 'Lunch' }, { status: 'applied' }),
    action('a-other', 'plan_confirm', { title: 'Dinner' }, { sessionId: 'session:group:other', conversationId: 'other' }),
  ]);
  const view = await render(fake.api);
  try {
    assert.deepEqual(fake.lists, [SESSION]);
    assert.ok(view.region(), 'region is shown');
    assert.deepEqual(view.items(), ['calendar_disclosure', 'plan_rsvp'], 'closed, expired, and other chats are left out');
    const text = view.region()?.textContent ?? '';
    assert.match(text, /Share your calendar in this chat\?/);
    assert.match(text, /Atlas wants to read your saved Kordi calendar for Fri, Oct 2 – Sat, Oct 3 and may summarize it for everyone here\./);
    assert.match(text, /If you allow this, Atlas can read these dates again in this chat for the next 10 minutes\./);
    assert.match(text, /PiP noted you're in/);
    assert.equal(view.button('Allow sharing your calendar')?.textContent, 'Allow');
    assert.equal(view.button('Don\'t allow sharing your calendar')?.textContent, 'Don\'t allow');
    assert.equal(view.button('Confirm your answer for Lunch')?.textContent, 'Confirm');
    const item = view.host.querySelector('[data-pending-agent-action="calendar_disclosure"]');
    assert.ok(item?.getAttribute('aria-labelledby'));
    assert.equal(view.live(), '2 requests are waiting for you.', 'new actions are announced once');
  } finally {
    await view.close();
  }
});

test('approving and declining remove the action and announce the result', async () => {
  let release: () => void = () => undefined;
  const fake = fakeApi([calendar, rsvp], ({ actionId }) => (
    actionId === calendar.actionId ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve()
  ));
  const view = await render(fake.api);
  try {
    await view.click(view.button('Allow sharing your calendar'));
    assert.equal(view.button('Allow sharing your calendar')?.disabled, true, 'buttons wait while saving');
    assert.equal(view.button('Confirm your answer for Lunch')?.disabled, true);
    assert.equal(view.host.querySelector('[aria-busy="true"]')?.getAttribute('data-pending-agent-action'), 'calendar_disclosure');
    await view.dispatch(() => release());
    assert.deepEqual(fake.decisions[0], { actionId: 'a-calendar', decision: 'approve' });
    assert.deepEqual(view.items(), ['plan_rsvp']);
    assert.equal(view.live(), 'Calendar sharing allowed.');

    await view.click(view.button('Dismiss PiP\'s answer for Lunch'));
    assert.deepEqual(fake.decisions[1], { actionId: 'a-rsvp', decision: 'decline' });
    assert.equal(view.region(), null, 'the banner closes when nothing is waiting');
    assert.equal(view.live(), 'Suggestion dismissed.');
  } finally {
    await view.close();
  }
});

test('a changed plan or a closed request explains itself and refreshes', async () => {
  const fake = fakeApi([rsvp], async () => {
    fake.setActions([]);
    throw new CloudAuthError('plan_changed', 'The plan changed.', 409);
  });
  const view = await render(fake.api);
  try {
    await view.click(view.button('Confirm your answer for Lunch'));
    assert.equal(view.alert(), 'This plan changed. Check the card and try again.');
    assert.deepEqual(view.items(), [], 'the stale action is gone after the refresh');
    assert.equal(fake.lists.length, 2);
    await view.click([...view.host.querySelectorAll('button')].find((button) => button.textContent === 'Dismiss') ?? null);
    assert.equal(view.region(), null);
  } finally {
    await view.close();
  }

  const closed = fakeApi([calendar], async () => { throw new CloudAuthError('agent_action_closed', 'Closed.', 409); });
  const closedView = await render(closed.api);
  try {
    await closedView.click(closedView.button('Allow sharing your calendar'));
    assert.equal(closedView.alert(), 'This request is no longer waiting. Ask again if you still need it.');
  } finally {
    await closedView.close();
  }
});

test('other failures keep the action so the person can try again', async () => {
  let fail = true;
  const fake = fakeApi([calendar], async () => {
    if (fail) throw new Error('offline');
  });
  const view = await render(fake.api);
  try {
    await view.click(view.button('Don\'t allow sharing your calendar'));
    assert.equal(view.alert(), 'Couldn\'t save your answer. Try again.');
    assert.deepEqual(view.items(), ['calendar_disclosure']);
    assert.equal(view.button('Don\'t allow sharing your calendar')?.disabled, false);
    fail = false;
    await view.click(view.button('Don\'t allow sharing your calendar'));
    assert.equal(view.alert(), null, 'a new decision clears the old error');
    assert.equal(view.live(), 'Calendar sharing declined.');
  } finally {
    await view.close();
  }
});

test('sync events for this chat and window focus read the list again', async () => {
  const fake = fakeApi([]);
  const view = await render(fake.api);
  try {
    assert.equal(view.region(), null);
    assert.equal(view.live(), '');
    fake.setActions([calendar]);
    await view.dispatch(() => dispatchWindowEvent(AGENT_ACTION_UPDATED_EVENT, {
      action: { ...calendar, sessionId: 'session:group:other', conversationId: 'other' },
    }));
    assert.equal(fake.lists.length, 1, 'events for other chats are ignored');
    await view.dispatch(() => dispatchWindowEvent(AGENT_ACTION_UPDATED_EVENT, { action: calendar }));
    assert.equal(fake.lists.length, 2);
    assert.deepEqual(view.items(), ['calendar_disclosure']);
    assert.equal(view.live(), 'Waiting for you: Share your calendar in this chat?');

    fake.setActions([calendar, rsvp]);
    await view.dispatch(() => window.dispatchEvent(new window.Event('focus')));
    assert.equal(fake.lists.length, 3);
    assert.deepEqual(view.items(), ['calendar_disclosure', 'plan_rsvp']);
    assert.equal(view.live(), 'Waiting for you: PiP noted you\'re in', 'only the new action is announced');
  } finally {
    await view.close();
  }
});

test('servers without agent actions show nothing and never throw', async () => {
  const calls = {
    listAgentActions: async () => { throw new CloudAuthError('unknown', 'Not found', 404); },
  } as unknown as AgentTrustCalls;
  const view = await render({ session: async () => ({ token: 'token', accountId: 'acct_me' }), calls });
  try {
    assert.equal(view.region(), null);
    assert.equal(view.alert(), null);
  } finally {
    await view.close();
  }
  const signedOut = fakeApi([calendar]);
  const signedOutView = await render({ ...signedOut.api, session: async () => null });
  try {
    assert.equal(signedOutView.region(), null);
    assert.deepEqual(signedOut.lists, []);
  } finally {
    await signedOutView.close();
  }
});

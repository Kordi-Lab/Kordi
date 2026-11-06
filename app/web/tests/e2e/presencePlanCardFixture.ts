import type { Page } from '@playwright/test';
import { account } from './apiFixture';
import { installChatFixture, peerAccountId, peerName } from './chatFixture';

const SYSTEM_ACCOUNT_ID = 'acct_kordi_system';
const timestamp = '2026-11-05T12:00:00Z';

export type Frame = {
  t: number;
  subtitle: string | null;
  card: { top: number; height: number; width: number } | null;
  /** The transcript region: its viewport top, scroll position, row count, and loading state. */
  transcript: { top: number; scrollTop: number; scrollHeight: number; rows: number; loading: boolean; revealed: boolean; firstRow: string | null } | null;
  /** Message rows removed from the document since the previous frame (a re-mount shows as removals). */
  removedRows: number;
};

// Records the chat header presence line, the plan card box, and the transcript
// on every animation frame, from the first paint of each document.
export async function installFrameRecorder(page: Page) {
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    (window as unknown as { __kordiFrames: Frame[] }).__kordiFrames = frames;
    const start = performance.now();
    const rowSelector = '[data-transcript-row-key]';
    let removedRows = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          removedRows += (node.matches(rowSelector) ? 1 : 0) + node.querySelectorAll(rowSelector).length;
        });
      }
    }).observe(document, { childList: true, subtree: true });
    const tick = () => {
      const subtitle = document.querySelector('[data-chat-session-subtitle="true"]');
      const card = document.querySelector('section.app-plan-card');
      const rect = card?.getBoundingClientRect();
      const region = document.querySelector('[role="region"][aria-label="Conversation messages"]');
      let scroller: Element | null = region;
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const rows = region ? region.querySelectorAll(rowSelector) : [];
      frames.push({
        t: Math.round(performance.now() - start),
        subtitle: subtitle?.textContent ?? null,
        card: rect ? { top: Math.round(rect.top), height: Math.round(rect.height), width: Math.round(rect.width) } : null,
        transcript: region ? {
          top: Math.round((scroller ?? region).getBoundingClientRect().top),
          scrollTop: Math.round(scroller?.scrollTop ?? 0),
          scrollHeight: scroller?.scrollHeight ?? 0,
          rows: rows.length,
          loading: Boolean(document.querySelector('[data-transcript-initial-loading="true"]')),
          // History stays visibility:hidden until the transcript has measured its rows.
          revealed: document.querySelector('[data-virtual-transcript-session-ready]')?.getAttribute('data-virtual-transcript-session-ready') === 'true',
          firstRow: rows[0]?.getAttribute('data-transcript-row-key') ?? null,
        } : null,
        removedRows,
      });
      removedRows = 0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function takeFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const frames = (window as unknown as { __kordiFrames: Frame[] }).__kordiFrames;
    return frames.splice(0, frames.length);
  });
}

export async function installPresenceAndPlanCard(page: Page, baseURL: string, options: { history?: number } = {}) {
  const fixture = await installChatFixture(page, baseURL);
  // Earlier messages put the card at the bottom of a scrolled transcript, as in a real chat.
  for (let index = 0; index < (options.history ?? 0); index += 1) {
    const sequence = fixture.messages.length + 1;
    fixture.messages.push({
      ...fixture.messages[0], id: `browser-history-${sequence}`, client_message_id: `client-browser-history-${sequence}`,
      conversation_sequence: sequence, sender_account_id: index % 2 ? account.accountId : peerAccountId,
      content: { schema: 1, blocks: [{ type: 'text', text: `Earlier message ${sequence}` }], legacy_attachments: [] },
    });
  }
  const planCard = {
    type: 'plan_card', eventId: 'plan_fixture_meet', title: 'Meet Morgan', state: 'awaiting_confirmation', revision: 2, view: 'event',
    startAt: '2026-11-09T04:00:00Z', endAt: '2026-11-09T04:30:00Z', location: null, unresolvedFields: [],
    participants: [
      { participantId: peerAccountId, displayName: peerName, organizer: true, rsvp: 'yes', avatarUrl: null },
      { participantId: account.accountId, displayName: account.displayName, organizer: false, rsvp: 'pending', avatarUrl: null },
    ],
    managerIds: [peerAccountId],
  };
  fixture.messages.push({
    ...fixture.messages[0], id: 'browser-plan-card', client_message_id: 'client-browser-plan-card', conversation_sequence: fixture.messages.length + 1,
    sender_account_id: SYSTEM_ACCOUNT_ID, kind: 'text', created_at: '2026-11-05T12:01:00Z',
    content: { schema: 1, blocks: [{ type: 'text', text: 'Does Sunday evening work?' }, planCard as unknown as { type: string; text: string }], legacy_attachments: [] },
  });
  fixture.conversation.members.push({ ...fixture.conversation.members[1], account_id: SYSTEM_ACCOUNT_ID, display_name: 'System' });
  fixture.conversation.latest_message_sequence = fixture.messages.length;
  let presenceRequests = 0;
  await page.route('**/v1/cloud/presence/contacts', async route => {
    presenceRequests += 1;
    // A realistic network delay makes any pre-presence placeholder visible.
    await new Promise(resolve => setTimeout(resolve, 400));
    return route.fulfill({ json: { accounts: [{ accountId: peerAccountId, status: 'online', updatedAt: timestamp, lastSeenAt: null }] } });
  });
  return { fixture, presenceRequests: () => presenceRequests };
}

export function subtitlesSeen(frames: Frame[]) {
  return [...new Set(frames.map(frame => frame.subtitle).filter((value): value is string => Boolean(value)))];
}

/** Distinct plan card boxes the reader could see (history hidden while it measures does not count). */
export function visibleCardBoxes(frames: Frame[]) {
  return [...new Set(frames.flatMap(frame => (frame.card && frame.transcript?.revealed ? [JSON.stringify(frame.card)] : [])))];
}

/** Frames in which the transcript was mounted but its history was still hidden. */
export function hiddenTranscriptFrames(frames: Frame[]) {
  return frames.filter(frame => frame.transcript && frame.transcript.rows > 0 && !frame.transcript.revealed).length;
}

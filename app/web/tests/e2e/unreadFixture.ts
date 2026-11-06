import type { Page } from '@playwright/test';
import { account, installApiFixture } from './apiFixture';

// A signed-in account shaped like a real one: direct chats, groups that are
// read, partly read and unread on the server, and agent chats. Unread counts
// follow each conversation's server read cursor.
const timestamp = (minute: number) => new Date(Date.parse('2026-11-05T12:00:00Z') + minute * 60_000).toISOString();
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

type Member = [accountId: string, displayName: string];

export async function installUnreadFixture(page: Page, baseURL: string) {
  const requests = await installApiFixture(page, baseURL, true);
  const owner: Member = [account.accountId, account.displayName];
  const peers: Member[] = Array.from({ length: 8 }, (_, index) => [`acct_unread_peer_${index}`, `Peer ${index}`]);
  const conversations: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const expectedUnread: Record<string, number> = {};
  const add = (kind: 'direct' | 'group' | 'ai', title: string, members: Member[], total: number, unread: number, sessionId: (id: string) => string) => {
    const id = uuid(conversations.length + 1);
    const ownerRead = total - unread;
    conversations.push({ id, kind, shared_title: kind === 'group' ? title : null, version: 1,
      created_by_account_id: account.accountId, legacy_session_id: sessionId(id), group_space_id: null,
      group_title: kind === 'group' ? title : null, latest_message_sequence: total, created_at: timestamp(0),
      updated_at: timestamp(total + conversations.length),
      members: members.map(([accountId, displayName]) => ({ account_id: accountId, display_name: displayName, avatar_url: null,
        role: 'member', membership_state: 'active', version: 1,
        last_delivered_sequence: accountId === account.accountId ? ownerRead : total,
        last_read_sequence: accountId === account.accountId ? ownerRead : total, joined_at: timestamp(0), left_at: null })),
      preferences: { conversation_id: id, account_id: account.accountId, personal_title: null, version: 1 } });
    for (let sequence = 1; sequence <= total; sequence += 1) {
      // Everything after the owner's read cursor comes from someone else.
      const sender = sequence > ownerRead ? members[1 + (sequence % (members.length - 1))] : members[sequence % members.length];
      messages.push({ id: uuid(10_000 + messages.length), client_message_id: `client-${id}-${sequence}`, conversation_id: id,
        conversation_sequence: sequence, sender_account_id: sender?.[0] ?? account.accountId, kind: 'text',
        content: { schema: 1, blocks: [{ type: 'text', text: `${title} message ${sequence}` }], legacy_attachments: [] },
        reply_to_message_id: null, attachment_ids: [], version: 1, generation_status: null, provider_response_id: null,
        created_at: timestamp(sequence + conversations.length), edited_at: null, deleted_at: null });
    }
    expectedUnread[title] = unread;
    return sessionId(id);
  };
  for (let index = 0; index < 3; index += 1) {
    const peer = peers[index];
    add('direct', peer[1], [owner, peer], 6, index + 1,
      () => `session:direct-person:${[account.accountId, peer[0]].sort().join(':')}`);
  }
  let openGroupSessionId = '';
  for (let index = 0; index < 8; index += 1) {
    const unread = index % 3 === 0 ? 2 + (index % 2) : 0;
    const sessionId = add('group', `Team ${index}`, [owner, ...peers.slice(index % 4, (index % 4) + 3)], 10,
      index === 5 ? 4 : unread, id => `session:group:${id}`);
    if (index === 5) openGroupSessionId = sessionId;
  }
  for (let index = 0; index < 2; index += 1) add('ai', `Agent ${index}`, [owner], 2, 0, id => `session:ai:${id}`);
  // The group opened from the link is read once it shows.
  expectedUnread['Team 5'] = 0;

  const visibility = { hiddenSessionIds: [], deletedSessionIds: [], unreadSessionIds: [], pinnedSessionIds: [],
    mutedSessionIds: [], pinnedGroupSpaceIds: [] };
  await page.route('**/v*/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseURL) return route.abort();
    const path = url.pathname;
    let body: unknown;
    if (path === '/v1/cloud/contacts') body = { contacts: peers.map(([accountId, displayName]) => ({ accountId, displayName,
      avatarUrl: null, defaultAgent: null, nodeId: null, createdAt: timestamp(0) })), requests: [] };
    else if (path === '/v1/cloud/sessions/visibility') body = visibility;
    else if (path === '/v2/chat/sync/bootstrap') body = { protocol_version: 2, conversations, latest_messages: messages,
      session_visibility: visibility, next_cursor: 'unread-1', last_stream_seq: 1, server_time: timestamp(0) };
    else if (path === '/v2/chat/sync') body = { protocol_version: 2, events: [], next_cursor: 'unread-1', last_stream_seq: 1,
      has_more: false, server_time: timestamp(0) };
    else if (path === '/v2/chat/attention') body = conversations.filter(row => row.kind !== 'ai').map(row => ({
      conversation_id: row.id, session_id: row.legacy_session_id, unread_count: 0, thread_count: 0,
      next_root_id: null, next_message_id: null }));
    else if (/^\/v2\/chat\/conversations\/[^/]+\/messages$/.test(path)) {
      const id = path.split('/')[4];
      body = { messages: messages.filter(row => row.conversation_id === id), next_before_sequence: null, has_more: false };
    } else if (/^\/v2\/chat\/conversations\/[^/]+\/(read|delivered)$/.test(path)) body = {};
    else if (path.startsWith('/v1/cloud/auth/profiles/') || /^\/v1\/cloud\/accounts\/[^/]+\/profile$/.test(path)) {
      const accountId = decodeURIComponent(path.split('/')[path.startsWith('/v1/cloud/auth/') ? 5 : 4]);
      body = { accountId, displayName: peers.find(([id]) => id === accountId)?.[1] ?? accountId, avatarUrl: null,
        avatar: null, defaultAgent: null };
    } else if (path.startsWith('/v1/cloud/presence')) body = { presence: [] };
    else if (path === '/v2/calls/active') body = { calls: [] };
    else return route.fallback();
    requests.push({ path, headers: request.headers() });
    return route.fulfill({ status: 200, json: body });
  });
  const expectedTotal = Object.values(expectedUnread).reduce((sum, count) => sum + count, 0);
  return { requests, openGroupSessionId, openGroupTitle: 'Team 5', expectedUnread, expectedTotal };
}

export type UnreadBadgeSample = { t: number; title: string; rail: string[]; rows: Record<string, string> };

/** Records the document title, rail badge and sidebar row badges after every DOM commit. */
export async function recordUnreadBadges(page: Page) {
  await page.addInitScript(() => {
    const samples: UnreadBadgeSample[] = [];
    (window as unknown as { unreadBadgeSamples: UnreadBadgeSample[] }).unreadBadgeSamples = samples;
    const started = performance.now();
    let last = '';
    const sample = () => {
      const rows: Record<string, string> = {};
      for (const badge of document.querySelectorAll<HTMLElement>('.app-sidebar-unread-badge')) {
        let row = badge.parentElement;
        while (row && !row.querySelector('[class*="row-title"]')) row = row.parentElement;
        const label = row?.querySelector('[class*="row-title"]')?.textContent?.trim() ?? '?';
        rows[label] = badge.dataset.unreadCount ?? '';
      }
      const rail = [...document.querySelectorAll('.app-nav-rail-unread-badge')].map(badge => badge.textContent?.trim() ?? '');
      const key = JSON.stringify([document.title, rail, rows]);
      if (key === last) return;
      last = key;
      samples.push({ t: Math.round(performance.now() - started), title: document.title, rail, rows });
    };
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; sample(); });
    };
    const observe = () => {
      new MutationObserver(schedule).observe(document, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['data-unread-count'] });
      sample();
    };
    if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe);
  });
  return () => page.evaluate(() => (window as unknown as { unreadBadgeSamples: UnreadBadgeSample[] }).unreadBadgeSamples);
}

export function titleUnreadCount(title: string) {
  return Number(/^\((\d+)\)/.exec(title)?.[1] ?? 0);
}

import type { Page } from '@playwright/test';
import { account, installApiFixture } from './apiFixture';

export const peerAccountId = 'acct_browser_test_peer';
export const peerName = 'Morgan Lee';
export const chatSessionId = `session:direct-person:${[account.accountId, peerAccountId].sort().join(':')}`;
export const chatConversationId = `cloud:conversation:${peerAccountId}:person`;
const timestamp = '2026-11-05T12:00:00Z';

export async function installChatFixture(page: Page, baseURL: string) {
  const requests = await installApiFixture(page, baseURL, true);
  const member = (accountId: string, displayName: string) => ({ account_id: accountId, display_name: displayName,
    avatar_url: null, role: 'member', membership_state: 'active', version: 1, last_delivered_sequence: 1,
    last_read_sequence: 1, joined_at: timestamp, left_at: null });
  const conversation = { id: 'browser-wire-chat', kind: 'direct', shared_title: null, version: 1,
    created_by_account_id: account.accountId, legacy_session_id: chatSessionId,
    latest_message_sequence: 1, created_at: timestamp, updated_at: timestamp,
    members: [member(account.accountId, account.displayName), member(peerAccountId, peerName)],
    preferences: { conversation_id: 'browser-wire-chat', account_id: account.accountId, personal_title: null, version: 1 } };
  const message = (id: string, text: string, senderAccountId: string, sequence: number) => ({ id,
    client_message_id: `client-${id}`, conversation_id: conversation.id, conversation_sequence: sequence,
    sender_account_id: senderAccountId, kind: 'text', content: { schema: 1, blocks: [{ type: 'text', text }], legacy_attachments: [] }, reply_to_message_id: null,
    attachment_ids: [] as string[], version: 1, generation_status: null, provider_response_id: null,
    created_at: timestamp, edited_at: null, deleted_at: null });
  const messages = [message('browser-history-1', 'The browser conversation is ready.', peerAccountId, 1)];
  const sent: unknown[] = [];
  const uploads: Buffer[] = [];
  const observedUploadBodies: Buffer[] = [];
  // WebKit omits Blob bytes from Playwright's intercepted Request. Observe the
  // original outgoing Blob without changing fetch or supplying replacement data.
  await page.exposeFunction('recordFixtureUploadBody', (bytes: number[]) => {
    observedUploadBodies.push(Buffer.from(bytes));
  });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (/\/v1\/cloud\/attachments\/[^/]+\/upload$/.test(url) && init?.body instanceof Blob) {
        const bytes = Array.from(new Uint8Array(await init.body.arrayBuffer()));
        await (window as unknown as { recordFixtureUploadBody(bytes: number[]): Promise<void> }).recordFixtureUploadBody(bytes);
      }
      return originalFetch(input, init);
    };
  });
  const visibility = { hiddenSessionIds: [], deletedSessionIds: [], unreadSessionIds: [],
    pinnedSessionIds: [], mutedSessionIds: [], pinnedGroupSpaceIds: [] };
  await page.route('**/v*/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseURL) return route.abort();
    const path = url.pathname;
    let body: unknown;
    if (path === '/v1/cloud/attachments/browser-file-1/content') {
      requests.push({ path, headers: request.headers() });
      return route.fulfill({ status: 200, contentType: 'text/plain', body: uploads[uploads.length - 1] ?? Buffer.alloc(0) });
    }
    if (path === '/v1/cloud/attachments/initiate') body = { attachmentId: 'browser-file-1', objectKey: 'synthetic/file',
      uploadUrl: `${baseURL}/v1/cloud/attachments/browser-file-1/upload`, expiresAt: '2099-01-01T00:00:00Z' };
    else if (path === '/v1/cloud/attachments/browser-file-1/upload') {
      const bytes = request.postDataBuffer() ?? observedUploadBodies[observedUploadBodies.length - 1] ?? Buffer.alloc(0);
      uploads.push(bytes);
      body = { attachmentId: 'browser-file-1', objectKey: 'synthetic/file', sizeBytes: bytes.length,
        contentType: request.headers()['content-type'], sha256Hex: null, finalizedAt: timestamp };
    }
    else if (path === '/v1/cloud/contacts') body = { contacts: [{ accountId: peerAccountId, displayName: peerName,
      avatarUrl: null, defaultAgent: null, nodeId: null, createdAt: timestamp }], requests: [] };
    else if (path === '/v1/cloud/sessions/visibility') body = visibility;
    else if (path === '/v1/cloud/contacts/requests') body = { requests: [] };
    else if (path === '/v2/chat/sync/bootstrap') body = { protocol_version: 2, conversations: [conversation],
      latest_messages: messages, session_visibility: visibility, next_cursor: `chat-${messages.length}`,
      last_stream_seq: messages.length, server_time: timestamp };
    else if (path === '/v2/chat/sync') body = { protocol_version: 2, events: [], next_cursor: `chat-${messages.length}`,
      last_stream_seq: messages.length, has_more: false, server_time: timestamp };
    else if (path === '/v2/chat/conversations') body = { conversation };
    else if (path === `/v2/chat/conversations/${conversation.id}/messages`) {
      if (request.method() === 'POST') {
        const input = request.postDataJSON() as { client_message_id: string; content: { schema: number; blocks: { type: string; text: string }[]; legacy_attachments: never[] }; attachment_ids: string[] };
        const row = { ...message(`browser-sent-${messages.length}`, input.content.blocks[0]?.text ?? '', account.accountId, messages.length + 1),
          client_message_id: input.client_message_id, content: input.content, attachment_ids: input.attachment_ids };
        messages.push(row); sent.push(input); conversation.latest_message_sequence = messages.length;
        body = { message: row };
      } else {
        const before = Number(url.searchParams.get('before_sequence') ?? Number.MAX_SAFE_INTEGER);
        body = { messages: messages.filter(row => row.conversation_sequence < before), next_before_sequence: null, has_more: false };
      }
    } else if (path === `/v2/chat/conversations/${conversation.id}/read` || path === `/v2/chat/conversations/${conversation.id}/delivered`) body = {};
    else if (path.startsWith('/v1/cloud/auth/profiles/')) body = { accountId: peerAccountId, displayName: peerName,
      avatar: { kind: 'generated', seed: peerAccountId, version: 0 }, defaultAgent: null };
    else return route.fallback();
    requests.push({ path, headers: request.headers() });
    return route.fulfill({ status: 200, json: body });
  });
  return { requests, sent, messages, conversation, uploads };
}

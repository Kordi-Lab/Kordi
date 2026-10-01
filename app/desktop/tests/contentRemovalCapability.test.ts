import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatSyncState } from '../src/features/cloud/chatSyncState';
import { ChatSyncSyncClient } from '../src/features/cloud/chatSyncSyncClient';
import { CloudMessageDeletions } from '../src/features/cloud/cloudMessageDeletions';
import {
  normalizeContentRemovalVersion,
  resetServerContentRemovalVersion,
  serverContentRemovalVersion,
  setServerContentRemovalVersion,
  subscribeServerContentRemovalVersion,
  useServerContentRemovalVersion,
} from '../src/features/cloud/contentRemovalCapability';
import type { ChatSyncBootstrapResponse, ChatSyncSyncResponse } from '../src/features/cloud/chatSyncTypes';
import { conversation } from './helpers/chatSyncCanonicalFixtures';

function syncResponse(extra: Partial<ChatSyncSyncResponse> = {}): ChatSyncSyncResponse {
  return { protocol_version: 2, events: [], next_cursor: 'cursor-next', last_stream_seq: 1,
    has_more: false, server_time: '2026-09-09T00:00:00Z', ...extra };
}

function bootstrapResponse(extra: Partial<ChatSyncBootstrapResponse> = {}): ChatSyncBootstrapResponse {
  return { protocol_version: 2, conversations: [conversation], latest_messages: [],
    next_cursor: 'cursor-next', last_stream_seq: 1, server_time: '2026-09-09T00:00:00Z', ...extra };
}

function clientWith(responses: unknown[], account: { id: string }) {
  const state = new ChatSyncState(
    async <T>() => responses.shift() as T,
    () => account.id,
    (value) => { account.id = value; },
    () => null,
    new CloudMessageDeletions(async () => []),
  );
  return { state, client: new ChatSyncSyncClient(state) };
}

function VersionProbe() {
  return createElement('span', null, `version:${useServerContentRemovalVersion()}`);
}

test('sync responses set the content removal version and a missing field means 0', async () => {
  resetServerContentRemovalVersion();
  const { client } = clientWith([
    syncResponse({ content_removal_version: 1 }),
    syncResponse(),
  ], { id: 'acct_b' });

  await client.syncCloudEvents('test-token', 'cursor-1');
  assert.equal(serverContentRemovalVersion(), 1);
  assert.equal(renderToStaticMarkup(createElement(VersionProbe)), '<span>version:1</span>');

  await client.syncCloudEvents('test-token', 'cursor-2');
  assert.equal(serverContentRemovalVersion(), 0, 'an older server omits the field');
  assert.equal(renderToStaticMarkup(createElement(VersionProbe)), '<span>version:0</span>');
});

test('bootstrap responses set the content removal version', async () => {
  resetServerContentRemovalVersion();
  const { client } = clientWith([
    bootstrapResponse({ content_removal_version: 1 }),
    bootstrapResponse(),
  ], { id: 'acct_b' });

  await client.bootstrapChatSync('test-token');
  assert.equal(serverContentRemovalVersion(), 1);
  await client.bootstrapChatSync('test-token');
  assert.equal(serverContentRemovalVersion(), 0);
});

test('an account change resets the content removal version', async () => {
  resetServerContentRemovalVersion();
  const account = { id: 'acct_b' };
  const { state, client } = clientWith([syncResponse({ content_removal_version: 1 })], account);
  await client.syncCloudEvents('test-token', 'cursor-1');
  assert.equal(serverContentRemovalVersion(), 1);

  state.rememberConversation({
    ...conversation,
    preferences: { ...conversation.preferences, account_id: 'acct_other' },
  });
  assert.equal(account.id, 'acct_other');
  assert.equal(serverContentRemovalVersion(), 0);

  setServerContentRemovalVersion(1, 'acct_other');
  account.id = 'acct_third';
  assert.equal(state.activeAccountId, 'acct_third');
  assert.equal(serverContentRemovalVersion(), 0, 'a sign-in outside chat sync also resets it');
});

test('a response for the previous account does not set the new account value', async () => {
  resetServerContentRemovalVersion();
  const account = { id: 'acct_b' };
  let finish!: (value: ChatSyncSyncResponse) => void;
  const pending = new Promise<ChatSyncSyncResponse>((resolve) => { finish = resolve; });
  const state = new ChatSyncState(
    async <T>() => (await pending) as T,
    () => account.id,
    (value) => { account.id = value; },
    () => null,
    new CloudMessageDeletions(async () => []),
  );
  const sync = new ChatSyncSyncClient(state).syncCloudEvents('test-token', 'cursor-1');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  account.id = 'acct_other';
  assert.equal(state.activeAccountId, 'acct_other');
  finish(syncResponse({ content_removal_version: 1 }));
  await sync;
  assert.equal(serverContentRemovalVersion(), 0);
});

test('only positive integers count as a reported version and listeners hear changes', () => {
  resetServerContentRemovalVersion();
  assert.deepEqual(
    [1, 2, 0, -1, 1.5, '1', null, undefined, Number.NaN].map(normalizeContentRemovalVersion),
    [1, 2, 0, 0, 0, 0, 0, 0, 0],
  );
  let notifications = 0;
  const unsubscribe = subscribeServerContentRemovalVersion(() => { notifications += 1; });
  setServerContentRemovalVersion(1, 'acct_b');
  setServerContentRemovalVersion(1, 'acct_b');
  resetServerContentRemovalVersion('acct_b');
  unsubscribe();
  setServerContentRemovalVersion(1, 'acct_b');
  assert.equal(notifications, 2);
  resetServerContentRemovalVersion();
});

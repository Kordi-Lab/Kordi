import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { publishCloudGroupCatalog, subscribeCloudGroupCatalog } from '../src/features/cloud/cloudGroupCatalogSync';
import { conversation as fixture } from './helpers/chatSyncCanonicalFixtures';
import type { ChatSyncConversation } from '../src/features/cloud/chatSyncTypes';

const group: ChatSyncConversation = {
  ...fixture,
  kind: 'group',
  legacy_session_id: 'session:group:live',
  latest_message_sequence: 0,
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('live catalog creates an empty group once, isolates accounts, and stops on unmount', async () => {
  const dom = new JSDOM();
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    CustomEvent: { configurable: true, value: dom.window.CustomEvent },
  });
  const sessions = new Set<string>();
  const rows: string[] = [];
  let remembered = 0;
  const errors: unknown[] = [];
  const unsubscribe = subscribeCloudGroupCatalog({
    accountId: 'acct_b',
    hasSession: id => sessions.has(id),
    rememberConversations: () => { remembered += 1; },
    applyRow: async row => {
      await tick();
      rows.push(row.envelope.groupId);
      assert.equal(row.envelope.message, undefined);
      sessions.add(row.envelope.groupId);
    },
    reportError: error => errors.push(error),
  });
  try {
    publishCloudGroupCatalog('acct_other', [group]);
    publishCloudGroupCatalog('acct_b', [fixture]);
    assert.equal(remembered, 0);
    publishCloudGroupCatalog('acct_b', [group]);
    publishCloudGroupCatalog('acct_b', [group]);
    await tick();
    await tick();
    assert.deepEqual(rows, ['session:group:live']);
    assert.equal(remembered, 2);
    publishCloudGroupCatalog('acct_b', [{
      ...group, legacy_session_id: 'session:group:left',
      members: group.members.map(member => ({ ...member, membership_state: 'left' })),
    }]);
    await tick();
    assert.equal(rows.length, 1);
    publishCloudGroupCatalog('acct_b', [{ ...group, legacy_session_id: 'session:group:queued' }]);
    unsubscribe();
    publishCloudGroupCatalog('acct_b', [{ ...group, legacy_session_id: 'session:group:after' }]);
    await tick();
    assert.equal(rows.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    unsubscribe();
    for (const key of ['window', 'CustomEvent']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

test('a failed live projection does not block another group or a later retry', async () => {
  const dom = new JSDOM();
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    CustomEvent: { configurable: true, value: dom.window.CustomEvent },
  });
  const applied: string[] = [];
  const errors: unknown[] = [];
  let shouldFail = true;
  const unsubscribe = subscribeCloudGroupCatalog({
    accountId: 'acct_b',
    hasSession: id => applied.includes(id),
    rememberConversations: () => {},
    applyRow: async row => {
      if (shouldFail) { shouldFail = false; throw new Error('temporary failure'); }
      applied.push(row.envelope.groupId);
    },
    reportError: error => errors.push(error),
  });
  try {
    publishCloudGroupCatalog('acct_b', [group, { ...group, legacy_session_id: 'session:group:next' }]);
    await tick();
    publishCloudGroupCatalog('acct_b', [group]);
    await tick();
    assert.deepEqual(applied, ['session:group:next', 'session:group:live']);
    assert.equal(errors.length, 1);
  } finally {
    unsubscribe();
    for (const key of ['window', 'CustomEvent']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

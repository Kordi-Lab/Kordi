import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __resetCloudBase64UrlCacheForTests,
  decodeBase64UrlUtf8,
  encodeBase64UrlUtf8,
} from '../src/features/cloud/cloudBase64Url';
import {
  encodeCloudGroupControl,
  parseCloudGroupControl,
} from '../src/features/cloud/cloudGroupMessages';
import { encodeCloudAgentResponse, parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';

function countAtob<T>(run: () => T): { value: T; calls: number } {
  const original = globalThis.atob;
  let calls = 0;
  globalThis.atob = (value: string) => {
    calls += 1;
    return original(value);
  };
  try {
    return { value: run(), calls };
  } finally {
    globalThis.atob = original;
  }
}

test('base64url envelopes round-trip UTF-8 text and match the per-byte encoding', () => {
  __resetCloudBase64UrlCacheForTests();
  const text = JSON.stringify({ text: 'Plain, accented é, CJK \u4e2d\u6587, emoji 🐦', long: 'x'.repeat(100_000) });
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  const expected = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  assert.equal(encodeBase64UrlUtf8(text), expected);
  assert.equal(decodeBase64UrlUtf8(expected), text);
  assert.throws(() => decodeBase64UrlUtf8('not base64 !'));
});

test('an unchanged envelope body is decoded once across repeated parses', () => {
  __resetCloudBase64UrlCacheForTests();
  const participant = { accountId: 'acct_owner', displayName: 'Owner' };
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:synthetic',
    createdByAccountId: 'acct_owner',
    actor: participant,
    participants: [participant, { accountId: 'acct_peer', displayName: 'Peer' }],
    message: { id: 'message-1', senderAccountId: 'acct_owner', text: 'Hello', createdAtMs: 1 },
  });
  const agentBody = encodeCloudAgentResponse({ requestId: 'request-1', text: 'Done', deliveryState: 'complete' });
  const first = countAtob(() => [parseCloudGroupControl(body), parseCloudAgentResponse(agentBody)]);
  assert.equal(first.calls, 2);
  assert.equal(first.value[0]?.message?.text, 'Hello');
  assert.equal(first.value[1]?.text, 'Done');
  const repeated = countAtob(() => {
    for (let index = 0; index < 50; index += 1) {
      assert.equal(parseCloudGroupControl(body)?.message?.text, 'Hello');
      assert.equal(parseCloudAgentResponse(agentBody)?.text, 'Done');
    }
  });
  assert.equal(repeated.calls, 0, 'cached envelope text must not be decoded again');
});

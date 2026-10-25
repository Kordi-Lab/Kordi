import assert from 'node:assert/strict';
import { test } from 'node:test';

import { transcriptMessageRenderKeys } from '../src/features/chat/transcriptRenderKeys';
import type { Message } from '../src/kordi-app/types';

const request: Message = {
  id: 'queued-local-chat:session:1', clientMessageId: 'queued-local-chat:session:1', role: 'user', text: 'hello', time: '09:31',
};
// The transcript drops a self reply's quote, so only its aliases name the request.
const reply = (id: string, replyAliasIds: string[] = [request.id!]): Message => ({
  id, role: 'owned-agent', text: '', time: '09:31', replyAliasIds,
});

test('a Cloud agent reply keeps one row from its pending placeholder to its stored reply', () => {
  const pending = reply(`msg:cloud:self:pending:${request.id}`, []);
  const stored = reply('msg:cloud:self:response:01a173e7', [request.id!, '01a173e7']);
  const before = transcriptMessageRenderKeys([request, pending]);
  const after = transcriptMessageRenderKeys([request, stored]);
  assert.equal(before.get(pending), 'self-agent-reply:client-message:queued-local-chat:session:1');
  assert.equal(after.get(stored), before.get(pending));
  // The request's runtime copy keeps the same reply key.
  const runtimeRequest = { ...request, id: 'desktop-entry:session:1:7', entryId: '01a173e7' };
  assert.equal(transcriptMessageRenderKeys([runtimeRequest, stored]).get(stored), before.get(pending));
});

test('reply keys stay unique, and other rows keep their own keys', () => {
  const pending = reply(`msg:cloud:self:pending:${request.id}`);
  const stored = reply('msg:cloud:self:response:01a1');
  const notice = reply(`msg:cloud:self:pending:${request.id}:not-started`);
  const keys = transcriptMessageRenderKeys([request, pending, stored, notice]);
  assert.equal(keys.get(pending), 'self-agent-reply:client-message:queued-local-chat:session:1');
  assert.equal(keys.get(stored), 'message:msg:cloud:self:response:01a1');
  assert.equal(keys.get(notice), `message:msg:cloud:self:pending:${request.id}:not-started`);
  const group = reply('msg:cloud:group:1');
  const orphan = reply('msg:cloud:self:response:02b2', ['unknown-request']);
  const other = transcriptMessageRenderKeys([request, group, orphan]);
  assert.equal(other.get(group), 'message:msg:cloud:group:1');
  assert.equal(other.get(orphan), 'message:msg:cloud:self:response:02b2');
});

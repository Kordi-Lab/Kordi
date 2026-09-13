import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planCloudSelfAgentSync, type CloudSelfAgentSyncOperation } from '../src/features/cloud/cloudSelfAgentForwardSync';
import { publishCloudSelfAgentOperations } from '../src/features/cloud/cloudSelfAgentForwardExecution';
import { selfAgentMessageAttachments } from '../src/features/cloud/cloudSelfAgentAttachments';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import type { SendCloudMessageOptions, CloudMessage } from '../src/features/cloud/authClient';

const local = { name: 'marker.png', kind: 'image', localPath: '/tmp/synthetic-marker.png', mimeType: 'image/png', sizeBytes: 42 };
const attachment = { attachmentId: 'attachment-marker', name: 'marker.png', kind: 'image' as const, mimeType: 'image/png', sizeBytes: 42 };
const operation: CloudSelfAgentSyncOperation = { localMessageId: 'local', sessionId: 'chat', role: 'user', text: '', parentLocalMessageId: null, createdAtMs: 1000, deliveryState: 'sent', attachments: selfAgentMessageAttachments({ attachments: [local] }) };

test('private agent publication uploads attachments before publishing the original message', async () => {
  const events: string[] = [];
  await publishCloudSelfAgentOperations({
    accountId: 'owner', token: 'fixture-token', ledger: {}, operations: [operation], mergeMessage() {}, saveLedger() {}, shouldPublishProcessing: () => false,
    uploadAttachments: async (input) => { events.push('upload'); assert.deepEqual(input.attachments, operation.attachments); return [attachment]; },
    client: { sendMessage: async (_token: string, _peer: string, body: string, options: SendCloudMessageOptions = {}) => {
      events.push('send'); assert.equal(body, ''); assert.deepEqual(options.attachments, [attachment]);
      assert.equal(JSON.stringify(options).includes(local.localPath), false);
      return { messageId: 'remote', body, fromAccountId: 'owner', toAccountId: 'owner', createdAt: '', deliveredAt: null, readAt: null } as CloudMessage;
    } },
  });
  assert.deepEqual(events, ['upload', 'send']);
});

test('upload failures and account cancellation never publish a text-only replacement', async () => {
  let sends = 0; let saved = 0;
  const input = { accountId: 'owner', token: 'fixture-token', ledger: {}, operations: [operation], mergeMessage() {}, saveLedger() { saved++; }, client: { sendMessage: async () => { sends++; throw new Error('unexpected send'); } } };
  await assert.rejects(publishCloudSelfAgentOperations({ ...input, uploadAttachments: async () => { throw new Error('upload failed'); } }), /upload failed/);
  let active = true;
  await publishCloudSelfAgentOperations({ ...input, shouldContinue: () => active, uploadAttachments: async () => { active = false; return [attachment]; } });
  assert.equal(sends, 0); assert.equal(saved, 0);
});

test('attachment-only local requests remain eligible for synchronization', () => {
  const state = { profile: {}, sessions: [{ id: 'chat', kind: 'self-agent', status: 'active' }], participants: [], identities: [], messages: [{ id: 'local', sessionId: 'chat', senderRole: 'user', messageKind: 'text', contentText: '', content: { attachments: [local] }, status: 'sent', sequenceNum: 1, createdAtMs: 1000, updatedAtMs: 1000 }] } as unknown as CanonicalSessionState;
  const planned = planCloudSelfAgentSync(state, {});
  assert.equal(planned.length, 1); assert.equal(planned[0].attachments?.length, 1);
});

test('a send retry reuses uploaded attachment ids without uploading or duplicating them', async () => {
  const ledger = {};
  let uploads = 0; let sends = 0;
  const input = {
    accountId: 'owner', token: 'fixture-token', ledger, operations: [operation], mergeMessage() {}, saveLedger() {}, shouldPublishProcessing: () => false,
    uploadAttachments: async () => { uploads++; return [attachment]; },
    client: { sendMessage: async (_token: string, _peer: string, body: string, options: SendCloudMessageOptions = {}) => {
      sends++; assert.deepEqual(options.attachments, [attachment]);
      if (sends === 1) throw new Error('temporary disconnect');
      return { messageId: 'remote', body, fromAccountId: 'owner', toAccountId: 'owner', createdAt: '', deliveredAt: null, readAt: null } as CloudMessage;
    } },
  };
  await assert.rejects(publishCloudSelfAgentOperations(input), /temporary disconnect/);
  await publishCloudSelfAgentOperations(input);
  await publishCloudSelfAgentOperations(input);
  assert.equal(uploads, 1); assert.equal(sends, 2);
});

test('cloud restoration retains image-only messages and attachment metadata', async () => {
  const { planCloudSelfAgentCanonicalSync } = await import('../src/features/cloud/cloudSelfAgentCanonicalSync');
  const { cloudAccountAvatarFixture } = await import('./helpers/cloudAccountAvatarFixture');
  const account = { accountId: 'owner', displayName: 'Owner', primaryEmail: 'owner@example.com', avatarUrl: null, avatar: cloudAccountAvatarFixture, nodeId: null, passwordSet: true };
  const message: CloudMessage = { messageId: 'remote', fromAccountId: 'owner', toAccountId: 'owner', sessionId: 'chat', body: '', attachments: [attachment], createdAt: '2026-09-01T00:00:00Z', deliveredAt: null, readAt: null };
  const state = { sessions: [], identities: [], participants: [], profile: { id: 'profile', humanIdentityId: 'human:owner', createdAtMs: 1, updatedAtMs: 1 }, messages: [], delegatedExchanges: [], presence: [], contextSnapshots: [], storagePath: '/tmp/synthetic' } as unknown as CanonicalSessionState;
  const planned = planCloudSelfAgentCanonicalSync({ account, messages: [message], state });
  assert.equal(planned.messageRequests.length, 1);
  assert.deepEqual((planned.messageRequests[0].content as { attachments: unknown }).attachments, [attachment]);
});

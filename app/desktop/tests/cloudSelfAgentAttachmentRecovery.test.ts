import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfAgentAttachmentUpdate } from '../src/features/cloud/cloudSelfAgentAttachmentState';
import { selfAgentMessageAttachments, uploadSelfAgentMessageAttachments } from '../src/features/cloud/cloudSelfAgentAttachments';
import { publishCloudSelfAgentOperations } from '../src/features/cloud/cloudSelfAgentForwardExecution';
import type { CloudMessage } from '../src/features/cloud/authClient';
import type { CloudSelfAgentSyncOperation } from '../src/features/cloud/cloudSelfAgentForwardSync';

const image = { attachmentId: 'image-1', name: 'image.png', kind: 'image' as const, mimeType: 'image/png', sizeBytes: 40 };
const message = { messageId: 'message', attachments: [image], version: 1 } as CloudMessage;
const operation = (id: string): CloudSelfAgentSyncOperation => ({ localMessageId: id, sessionId: 'chat', role: 'user', text: '', parentLocalMessageId: null, createdAtMs: 1000, deliveryState: 'sent' });

test('explicit removal of the final attachment is synchronized and stale snapshots cannot restore it', () => {
  const saved = selfAgentAttachmentUpdate(message, {}).content;
  const removal = selfAgentAttachmentUpdate({ ...message, version: 2, attachments: [] }, saved);
  assert.equal(removal.changed, true);
  assert.deepEqual(removal.content.attachments, []);
  assert.equal(selfAgentAttachmentUpdate(message, removal.content).changed, false);
  assert.equal(selfAgentAttachmentUpdate({ ...message, version: undefined }, removal.content).changed, false);
  assert.deepEqual(selfAgentAttachmentUpdate({ ...message, attachments: undefined }, saved).content, saved);
});

test('metadata roundtrips keep local access paths without treating them as server content changes', () => {
  const saved = { attachments: [{ ...image, localPath: '/tmp/synthetic.png' }], cloudAttachmentVersion: 1 };
  assert.equal(selfAgentAttachmentUpdate(message, saved).changed, false);
  assert.equal(selfAgentAttachmentUpdate({ ...message, version: 3 }, saved).changed, true);
  assert.equal(selfAgentAttachmentUpdate({ ...message, version: 3 }, saved).content.attachments[0].localPath, '/tmp/synthetic.png');
});

test('cloud-only attachment references do not require a local download or upload', async () => {
  const attachments = selfAgentMessageAttachments({ attachments: [image] });
  const uploaded = await uploadSelfAgentMessageAttachments({ ...operation('cloud-only'), attachments }, { sendMessage: async () => { throw new Error('Unexpected send'); } }, 'fixture-token');
  assert.equal(uploaded[0].attachmentId, image.attachmentId);
});

test('sticker, meme, dimensions, and Live Photo metadata are preserved', () => {
  const motion = { video: { attachmentId: 'video', name: 'Live.mov', mimeType: 'video/quicktime', sizeBytes: 40 }, playback: { attachmentId: 'playback', name: 'Live.mp4', mimeType: 'video/mp4', sizeBytes: 40 } };
  const [parsed] = selfAgentMessageAttachments({ attachments: [{ ...image, subtype: 'meme', altText: 'Caption', widthPixels: 12, heightPixels: 8, livePhoto: motion, livePhotoFiles: { videoPath: '/tmp/video.mov', playbackPath: '/tmp/video.mp4' } }] });
  assert.equal(parsed.subtype, 'meme'); assert.equal(parsed.altText, 'Caption');
  assert.equal(parsed.widthPixels, 12); assert.equal(parsed.heightPixels, 8);
  assert.deepEqual(parsed.livePhoto, motion); assert.ok(parsed.livePhotoFiles);
  assert.equal(selfAgentMessageAttachments({ attachments: [{ ...image, subtype: 'sticker' }] })[0].subtype, 'sticker');
});

test('an unavailable attachment does not block unrelated messages in the same sync batch', async () => {
  const sent: string[] = [];
  await assert.rejects(publishCloudSelfAgentOperations({
    accountId: 'owner', token: 'fixture-token', ledger: {}, mergeMessage() {}, saveLedger() {}, shouldPublishProcessing: () => false,
    operations: [{ ...operation('broken'), attachments: selfAgentMessageAttachments({ attachments: [{}] }) }, { ...operation('good'), text: 'Intact message' }],
    uploadAttachments: async input => { if (input.localMessageId === 'broken') throw new Error('Attachment unavailable'); return []; },
    client: { sendMessage: async (_token, _peer, body) => { sent.push(body); return { ...message, messageId: 'sent' }; } },
  }), /Attachment unavailable/);
  assert.deepEqual(sent, ['Intact message']);
});

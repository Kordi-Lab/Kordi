import assert from 'node:assert/strict';
import test from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import {
  cloudGroupAttachmentRepairReplayKey,
  cloudGroupAttachmentRepairReplayRows,
} from '../src/features/cloud/cloudGroupAttachmentRepair';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { CloudGroupReplayCoordinator } from '../src/features/cloud/cloudGroupReplayCoordinator';
import { buildCloudMessageIndex, cloudGroupReplayKeyForRow } from '../src/features/cloud/cloudMessageIndex';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';

const groupId = 'session:group:attachment-repair';
const requestId = 'msg:ui:attachment-repair-request';
const ownerAccountId = 'acct_owner';
const wireId = 'wire_attachment_repair';
const document = {
  attachmentId: 'att_agentdoc_repair',
  name: 'notes.md',
  kind: 'file' as const,
  mimeType: 'text/markdown',
  sizeBytes: 12,
  previewUrl: null,
};

function replyRow(options: { attachments: boolean; senderKind?: 'agent' | 'human' }) {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: 'Repair group',
    createdByAccountId: ownerAccountId,
    actor: { accountId: ownerAccountId, displayName: 'Owner', role: 'person' },
    participants: [
      { accountId: ownerAccountId, displayName: 'Owner', role: 'admin' },
      { accountId: 'acct_member', displayName: 'Member', role: 'person' },
    ],
    message: {
      id: 'msg:cloud-agent:turn',
      senderAccountId: ownerAccountId,
      senderKind: options.senderKind ?? 'agent',
      senderDisplayName: 'Kordi',
      text: 'Created the notes.',
      createdAtMs: 2_000,
      deliveryState: 'complete',
      requestId,
      replyToMessageId: requestId,
      ...(options.attachments ? { attachments: [document] } : {}),
    },
  });
  const wire: CloudMessage = {
    messageId: wireId,
    fromAccountId: ownerAccountId,
    toAccountId: 'acct_member',
    body,
    createdAt: '2026-10-19T00:00:02.000Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: groupId,
    version: 1,
    conversationSequence: 7,
    ...(options.attachments ? { attachments: [document] } : {}),
  };
  return buildCloudMessageIndex(ownerAccountId, { acct_member: [wire] }).replayRows[0]!;
}

/** The owner's reply row, written from the Mac's own copy of the reply. */
function loadedReply(attachments: unknown[] = []): CanonicalSessionMessage {
  return {
    id: `msg:cloud-agent-processing:${requestId}:${ownerAccountId}`,
    sessionId: groupId,
    senderIdentityId: `agent:cloud:${ownerAccountId}`,
    senderRole: 'owned-agent',
    messageKind: 'agent-turn',
    contentText: 'Created the notes.',
    content: { requestId, deliveryState: 'complete', cloudMessageVersion: 1, conversationSequence: 7, attachments },
    parentMessageId: requestId,
    status: 'received',
    sequenceNum: 2,
    createdAtMs: 2_000,
    updatedAtMs: 2_000,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: `cloud-group-agent:${wireId}`,
  };
}

test('a loaded agent reply missing the stored document is replayed again', () => {
  const row = replyRow({ attachments: true });
  assert.deepEqual(cloudGroupAttachmentRepairReplayRows([row], [loadedReply()]), [row]);
  assert.deepEqual(cloudGroupAttachmentRepairReplayRows([row], [loadedReply([document])]), []);
});

test('attachment repair leaves other rows to the normal replay', () => {
  assert.deepEqual(cloudGroupAttachmentRepairReplayRows([replyRow({ attachments: false })], [loadedReply()]), []);
  assert.deepEqual(cloudGroupAttachmentRepairReplayRows([replyRow({ attachments: true, senderKind: 'human' })], [loadedReply()]), []);
  const row = replyRow({ attachments: true });
  assert.deepEqual(cloudGroupAttachmentRepairReplayRows([row], []), []);
  assert.deepEqual(cloudGroupAttachmentRepairReplayRows([row], [{ ...loadedReply(), sourceEventId: 'cloud-group-agent:other' }]), []);
});

test('the repair runs once even though the normal replay key already completed', async () => {
  const row = replyRow({ attachments: true });
  const coordinator = new CloudGroupReplayCoordinator<typeof row>();
  coordinator.changeAccount('acct_owner:identity');
  const applied: string[] = [];
  await coordinator.request({
    entries: [{ key: cloudGroupReplayKeyForRow(row), row }],
    apply: async () => { applied.push('first'); },
  });
  await coordinator.request({
    entries: [{ key: cloudGroupReplayKeyForRow(row), row }],
    apply: async () => { applied.push('skipped'); },
  });
  const key = cloudGroupAttachmentRepairReplayKey(row);
  assert.match(key, /att_agentdoc_repair$/);
  for (const label of ['repaired', 'repeated']) {
    await coordinator.request({ entries: [{ key, row }], apply: async () => { applied.push(label); } });
  }
  assert.deepEqual(applied, ['first', 'repaired']);
  coordinator.dispose();
});

test('replaying the repair row adds the document to the loaded reply', async () => {
  const { mockIPC, clearMocks } = await import('@tauri-apps/api/mocks');
  const { applyCloudGroupMessageControl } = await import('../src/features/cloud/cloudGroupMessageControl');
  const application = await import('../src/features/cloud/useCloudGroupControlApplication');
  const requestState = await import('../src/features/cloud/cloudAgentRequestState');
  const { upsertCanonicalIdentityIntoLocalState } = await import('../src/features/cloud/cloudCanonicalStateMerge');
  const { cleanCloudText, cloudObjectContent } = await import('../src/features/cloud/cloudValue');
  const row = replyRow({ attachments: true });
  const loaded = loadedReply();
  const state = { messages: [loaded], identities: [], sessions: [] } as unknown as NonNullable<Parameters<typeof applyCloudGroupMessageControl>[0]['context']['canonicalState']>;
  const written: Array<Record<string, unknown>> = [];
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  mockIPC((command, payload) => {
    const request = (payload as { request: Record<string, unknown> }).request;
    if (command === 'desktop_canonical_upsert_identity_fast') return { ...request, createdAtMs: 1, updatedAtMs: 1 };
    assert.equal(command, 'desktop_canonical_upsert_message_fast');
    written.push(request);
    return { ...loaded, ...request };
  });
  try {
    const owner = { accountId: ownerAccountId, displayName: 'Owner', avatarUrl: null, role: 'admin' as const };
    await applyCloudGroupMessageControl({
      context: {
        account: { accountId: ownerAccountId } as never,
        cloudMessage: row.wire,
        envelope: row.envelope,
        canonicalState: state,
        nextState: state,
        localHumanIdentityId: 'human:owner',
        groupSpaceId: groupId,
        participantByAccount: new Map([[ownerAccountId, owner]]),
        identityIdByAccount: new Map([[ownerAccountId, 'human:owner']]),
      },
      setCanonicalState: () => undefined,
      stateOps: {
        objectContent: cloudObjectContent,
        cleanText: cleanCloudText,
        upsertIdentity: upsertCanonicalIdentityIntoLocalState,
        processingSlot: application.cloudGroupAgentProcessingSlotForResponse,
        incomingAlreadyApplied: application.cloudGroupIncomingMessageAlreadyApplied,
        removeOfflinePlaceholder: requestState.removeCloudGroupOfflinePlaceholder,
        removeTimeoutPlaceholder: requestState.removeCloudGroupTimeoutPlaceholderForTerminalResponse,
        removePendingRows: requestState.removeCloudGroupPendingRowsForTerminalResponse,
        removeMessage: requestState.removeCanonicalMessageById,
        isProcessingPlaceholder: requestState.isCloudAgentProcessingPlaceholderText,
      },
    });
  } finally {
    clearMocks();
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  const update = written.find((request) => request.id === loaded.id);
  assert.ok(update, JSON.stringify(written));
  const attachments = cloudObjectContent(update.content).attachments as Array<{ attachmentId: string }>;
  assert.deepEqual(attachments.map((attachment) => attachment.attachmentId), [document.attachmentId]);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import type { CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { CloudGroupReplayCoordinator } from '../src/features/cloud/cloudGroupReplayCoordinator';
import {
  cloudGroupTerminalRepairReplayKey,
  cloudGroupTerminalRepairReplayRows,
} from '../src/features/cloud/cloudGroupTerminalRepair';
import type { CanonicalSessionMessage } from '../src/kordi-app/types';

const groupId = 'session:group:terminal-repair';
const requestId = 'msg:ui:terminal-repair-request';
const ownerAccountId = 'acct_owner';

function terminalRow() {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: 'Repair group',
    createdByAccountId: 'acct_requester',
    actor: {
      accountId: ownerAccountId,
      displayName: 'Owner',
      role: 'person',
    },
    participants: [
      { accountId: 'acct_requester', displayName: 'Requester', role: 'admin' },
      { accountId: ownerAccountId, displayName: 'Owner', role: 'person' },
    ],
    message: {
      id: 'cloudrunmsg_terminal_repair',
      senderAccountId: ownerAccountId,
      senderKind: 'agent',
      senderDisplayName: "Owner's Kordi",
      text: 'The durable terminal answer.',
      createdAtMs: 2_000,
      deliveryState: 'complete',
      requestId,
      replyToMessageId: requestId,
    },
  });
  const wire: CloudMessage = {
    messageId: 'wire_terminal_repair',
    fromAccountId: ownerAccountId,
    toAccountId: 'acct_requester',
    body,
    createdAt: '2026-08-08T00:00:02.000Z',
    deliveredAt: '2026-08-08T00:00:03.000Z',
    readAt: null,
    direction: 'incoming',
    sessionId: groupId,
  };
  return buildCloudMessageIndex('acct_requester', {
    [ownerAccountId]: [wire],
  }).replayRows[0]!;
}

function processingSlot(status: 'processing' | 'complete'): CanonicalSessionMessage {
  return {
    id: `msg:cloud-agent-processing:${requestId}:${ownerAccountId}`,
    sessionId: groupId,
    senderIdentityId: `agent:cloud:${ownerAccountId}`,
    senderRole: 'external-agent',
    messageKind: 'agent-turn',
    contentText: status === 'processing' ? 'Processing…' : 'Done',
    content: { requestId, deliveryState: status },
    parentMessageId: requestId,
    status,
    sequenceNum: 2,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    sourceTransport: 'cloud-group-agent',
    sourceEventId: 'cloud-group-agent:processing',
  };
}

test('durable terminal replay targets only a matching live Processing slot', () => {
  const row = terminalRow();

  assert.deepEqual(
    cloudGroupTerminalRepairReplayRows([row], [processingSlot('processing')]),
    [row],
  );
  assert.deepEqual(
    cloudGroupTerminalRepairReplayRows([row], [processingSlot('complete')]),
    [],
  );
  assert.match(
    cloudGroupTerminalRepairReplayKey(row),
    /^terminal-repair:/,
  );
});

test('terminal repair uses a fresh coordinator key after durable replay completed', async () => {
  const row = terminalRow();
  const coordinator = new CloudGroupReplayCoordinator<typeof row>();
  coordinator.changeAccount('acct_requester:identity');
  const applied: string[] = [];

  await coordinator.request({
    entries: [{ key: 'group-message:already-durable', row }],
    apply: async () => { applied.push('durable'); },
  });
  await coordinator.request({
    entries: [{ key: 'group-message:already-durable', row }],
    apply: async () => { applied.push('shadowed'); },
  });
  await coordinator.request({
    entries: [{ key: cloudGroupTerminalRepairReplayKey(row), row }],
    apply: async () => { applied.push('repaired'); },
  });

  assert.deepEqual(applied, ['durable', 'repaired']);
  coordinator.dispose();
});

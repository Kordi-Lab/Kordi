import assert from 'node:assert/strict';
import test from 'node:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

import type { CloudAccount } from '../src/features/cloud/authClient';
import { canonicalMessageRole } from '../src/features/canonical/readModel/messageRole';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { canonicalMessageCountsAsReadable } from '../src/features/canonical/readModel/messageVisibility';
import {
  buildCloudCollaborationConversation,
  cloudDirectPersonSessionId,
} from '../src/features/cloud/cloudCollaborationState';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { applyCloudGroupMessageControl } from '../src/features/cloud/cloudGroupMessageControl';
import type { CloudGroupControlContext } from '../src/features/cloud/cloudGroupControlContext';
import { cleanCloudText, cloudObjectContent } from '../src/features/cloud/cloudValue';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { mapCollaborationConversationToViewModel } from '../src/features/collaboration/transcript';
import type { AppendCanonicalMessageRequest, CanonicalSessionMessage } from '../src/kordi-app/types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

const NOTICE = 'Casey turned on “Don\'t let AI use my messages.” Other people\'s agents, PiP, and digests will leave out their messages here.';

const row: CanonicalSessionMessage = {
  id: 'notice-row', sessionId: 'session:group:g', senderIdentityId: 'human:acct_c', senderRole: 'person',
  messageKind: 'ai-access-notice', contentText: NOTICE, content: {}, status: 'received', sequenceNum: 3,
  createdAtMs: 3, updatedAtMs: 3, sourceTransport: 'cloud-group',
};

test('AI access notices render as system rows and are never hidden', () => {
  assert.equal(canonicalMessageRole(row), 'system');
  assert.equal(canonicalMessageRole({ ...row, messageKind: 'text' }), 'person');
  const direct = encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: NOTICE });
  for (const message of [row, { ...row, contentText: direct, sourceTransport: 'cloud-direct' }]) {
    const mapped = mapCanonicalMessage(message, new Map());
    assert.equal(mapped?.role, 'system');
    assert.equal(mapped?.text, NOTICE);
    assert.equal(canonicalMessageCountsAsReadable(message), true);
  }
});

test('direct-chat notices become system rows in the collaboration transcript', () => {
  const account: CloudAccount = {
    accountId: 'acct_me', displayName: 'Me', primaryEmail: 'me@example.test', avatarUrl: null,
    avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
  };
  const peer = cloudContactToContact({
    accountId: 'acct_c', displayName: 'Casey', avatarUrl: null, nodeId: 'node_c', createdAt: '2026-10-01T00:00:00Z',
  });
  const conversation = buildCloudCollaborationConversation({
    account,
    contact: peer,
    runtime: 'person',
    messages: [{
      messageId: 'notice', fromAccountId: 'acct_c', toAccountId: 'acct_me',
      body: encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: NOTICE }),
      createdAt: '2026-10-01T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming',
      sessionId: cloudDirectPersonSessionId('acct_me', 'acct_c'), messageKind: 'ai-access-notice', attachments: [],
    }],
  });
  const view = mapCollaborationConversationToViewModel(conversation, undefined, 'Kordi');
  const notice = view.messages.find((message) => message.text === NOTICE);
  assert.equal(notice?.role, 'system');
});

function groupContext(wireKind: string, envelopeKind?: string): CloudGroupControlContext {
  const actor = { accountId: 'acct_c', displayName: 'Casey', avatarUrl: null, role: 'person' as const };
  const state = { messages: [], identities: [], sessions: [], participants: [] } as unknown as CloudGroupControlContext['canonicalState'];
  return {
    account: { accountId: 'acct_me' } as CloudGroupControlContext['account'],
    cloudMessage: {
      messageId: 'wire-notice', fromAccountId: 'acct_c', toAccountId: 'acct_me', body: '',
      createdAt: '2026-10-01T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming',
      sessionId: 'session:group:g', version: 1, conversationSequence: 3, messageKind: wireKind,
    },
    envelope: {
      kind: 'group-message', groupId: 'session:group:g', groupTitle: 'Weekend', createdByAccountId: 'acct_me',
      actor, participants: [actor],
      message: {
        id: 'notice:1', senderAccountId: 'acct_c', senderKind: 'human', text: NOTICE, createdAtMs: 3,
        ...(envelopeKind ? { messageKind: envelopeKind } : {}),
      },
    },
    canonicalState: state, nextState: state, localHumanIdentityId: 'human:acct_me',
    groupSpaceId: 'session:group:g', participantByAccount: new Map([['acct_c', actor]]),
    identityIdByAccount: new Map([['acct_c', 'human:acct_c']]),
  };
}

const unexpected = (): never => { throw new Error('Human notices must not enter agent-only branches'); };
const stateOps = {
  objectContent: cloudObjectContent, cleanText: cleanCloudText,
  upsertIdentity: unexpected, processingSlot: unexpected, incomingAlreadyApplied: unexpected,
  removeOfflinePlaceholder: unexpected, removeTimeoutPlaceholder: unexpected, removePendingRows: unexpected,
  removeMessage: (state: CloudGroupControlContext['canonicalState']) => state, isProcessingPlaceholder: unexpected,
};

async function storedGroupKind(wireKind: string, envelopeKind?: string): Promise<string> {
  const requests: AppendCanonicalMessageRequest[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  mockIPC(async (_command, payload) => {
    const request = payload?.request as AppendCanonicalMessageRequest;
    requests.push(request);
    return { ...row, ...request, sequenceNum: 3, updatedAtMs: 3 };
  });
  try {
    await applyCloudGroupMessageControl({ context: groupContext(wireKind, envelopeKind), setCanonicalState: () => undefined, stateOps });
  } finally {
    clearMocks();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  return requests[0]?.messageKind ?? '';
}

test('group notices keep the server-set kind, and envelopes cannot claim it', async () => {
  assert.equal(await storedGroupKind('ai-access-notice'), 'ai-access-notice');
  assert.equal(await storedGroupKind('text', 'ai-access-notice'), 'text');
  assert.equal(await storedGroupKind('text'), 'text');
});

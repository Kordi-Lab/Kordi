import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { cloudAgentPublicBackgroundToolsFromTurn } from '../src/features/cloud/cloudAgentBackgroundSessions';
import { publishCloudGroupAgentTerminalAfterGuards } from '../src/features/cloud/cloudGroupAgentPublication';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import type { CloudAccount } from '../src/features/cloud/authClient';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';
import { cloudGroupAgentCancelledNoticeRequest } from '../src/features/cloud/cloudAgentCancellation';

test('local group cancellation retains the owner trace for the stable response slot', () => {
  const request = cloudGroupAgentCancelledNoticeRequest({
    processingMessage: { id: 'response-slot', sessionId: 'group-session', senderIdentityId: 'owned-agent',
      senderRole: 'owned-agent', createdAtMs: 1_000, content: {} } as never,
    requestId: 'request', conversationId: 'group-session', cancelledByAccountId: 'acct_owner',
    cancelledByRole: 'agent owner', ownerThinkingText: 'Synthetic owner reasoning', now: 2_000,
  });
  assert.equal(request.id, 'response-slot');
  assert.equal(request.parentMessageId, 'request');
  assert.equal((request.content as { thinkingText: string }).thinkingText, 'Synthetic owner reasoning');
});

test('group publication contains the public answer, not owner reasoning or private tool output', async () => {
  const ownerTurn: DesktopChatTurnSnapshot = {
    id: 'owner-turn', sessionId: 'group-session', prompt: 'Synthetic request', status: 'complete', message: '',
    assistantText: 'Public answer', thinkingText: 'Synthetic owner reasoning', completed: true, succeeded: true,
    tools: [{ id: 'private-tool', name: 'read', status: 'complete', arguments: 'Synthetic owner input',
      liveOutput: 'Synthetic owner output', isError: false }],
  };
  const sent: string[] = [];
  const owner: CloudAccount = { accountId: 'acct_owner', displayName: 'Owner', primaryEmail: 'owner@example.test',
    nodeId: null, avatarUrl: null, avatar: cloudAccountAvatarFixture, passwordSet: true };
  const peer = { accountId: 'acct_peer', displayName: 'Peer' };
  await publishCloudGroupAgentTerminalAfterGuards({
    context: { account: owner, groupSpaceId: null,
      envelope: { groupId: 'session:group:synthetic', createdByAccountId: 'acct_peer', message: { id: 'request' } },
      participantByAccount: new Map([[owner.accountId, owner], [peer.accountId, peer]]) },
    runtime: { mergeMessage: () => undefined, syncDiff: () => undefined },
    policy: {}, token: 'synthetic-test-token', targetAccountIds: [owner.accountId, peer.accountId],
    responseMessageId: 'response', responseCreatedAtMs: 2_000,
    responseText: ownerTurn.assistantText, responseDeliveryState: 'complete',
    responseTools: cloudAgentPublicBackgroundToolsFromTurn(ownerTurn),
    agentId: 'agent:synthetic', agentDisplayName: 'Synthetic Agent', agentHandoff: null,
    signal: new AbortController().signal,
    publisher: { sendMessage: async (_token: string, _peer: string, body: string) => { sent.push(body); return {}; } },
  } as never);
  assert.equal(sent.length, 2);
  for (const body of sent) {
    assert.ok(body.startsWith('kordi-cloud-group:'));
    const decoded = Buffer.from(body.slice('kordi-cloud-group:'.length), 'base64').toString('utf8');
    assert.match(decoded, /Public answer/);
    assert.doesNotMatch(decoded, /Synthetic owner|thinkingText|private-tool/);
  }
});

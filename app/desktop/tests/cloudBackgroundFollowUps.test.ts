import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import type { MessageActionMetadata } from '../src/kordi-app/types/message';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import {
  cloudBackgroundFollowUpReply,
  cloudBackgroundFollowUpRoute,
  publishCloudBackgroundFollowUp,
  registerCloudBackgroundFollowUpHandler,
  type CloudBackgroundFollowUpReply,
  type CloudDirectBackgroundFollowUpRoute,
  type CloudGroupBackgroundFollowUpRoute,
} from '../src/features/cloud/cloudBackgroundFollowUps';
import { parseCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { publishCloudDirectBackgroundFollowUp } from '../src/features/cloud/cloudDirectBackgroundFollowUp';
import {
  cloudGroupBackgroundFollowUpRoute,
  publishCloudGroupBackgroundFollowUp,
} from '../src/features/cloud/cloudGroupBackgroundFollowUp';
import type {
  CloudGroupAgentRuntime,
  CloudGroupMessageControlContext,
} from '../src/features/cloud/cloudGroupControlContext';
import type { CloudGroupAgentPolicy } from '../src/features/cloud/cloudGroupAgentControl.types';
import { parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';

const thread: MessageActionMetadata = {
  schemaVersion: 1,
  kind: 'thread',
  source: { sourceSessionId: 'chat', sourceMessageId: 'thread-root', senderLabel: 'Member', textPreview: 'Root', attachmentCount: 0 },
};

function directRoute(patch: Partial<CloudDirectBackgroundFollowUpRoute> = {}): CloudDirectBackgroundFollowUpRoute {
  return {
    kind: 'direct', accountId: 'acct_owner', peerId: 'acct_peer', sessionId: 'session:direct',
    requestMessageId: 'request-1', messageAction: thread, ...patch,
  };
}

function followUpTurn(
  id: string,
  route: unknown,
  patch: Partial<DesktopChatTurnSnapshot> = {},
): DesktopChatTurnSnapshot {
  return {
    id: `turn-${id}`, sessionId: 'session:parent', prompt: 'Background session "Count lines" finished.',
    status: 'succeeded', message: 'Response complete', assistantText: 'The project has 1,204 lines.', thinkingText: '',
    tools: [], completed: true, succeeded: true,
    backgroundFollowUp: {
      id: `background-result:${id}:done`, sessionId: id, parentRequestId: 'request-1', title: 'Count lines',
      status: 'done', route,
    },
    ...patch,
  };
}

function recordingHandlers() {
  const published: { route: CloudDirectBackgroundFollowUpRoute; reply: CloudBackgroundFollowUpReply }[] = [];
  const marked: string[] = [];
  const unregister = registerCloudBackgroundFollowUpHandler('direct', async (route, reply) => {
    published.push({ route, reply });
    return true;
  });
  const markPublished = async (turnId: string) => { marked.push(turnId); };
  return { published, marked, unregister, markPublished };
}

test('a follow-up is published from the route it carries, with no publisher kept in memory', async () => {
  // A reloaded webview: nothing from the parent request is in memory, only the
  // handler registered by the mounted executor.
  const { published, marked, unregister, markPublished } = recordingHandlers();
  try {
    assert.equal(await publishCloudBackgroundFollowUp(followUpTurn('child-1', directRoute()), { markPublished }), true);
    assert.equal(published.length, 1);
    assert.equal(published[0]?.route.peerId, 'acct_peer');
    assert.equal(published[0]?.route.sessionId, 'session:direct');
    assert.equal(published[0]?.reply.requestId, 'background-result:child-1:done');
    assert.equal(published[0]?.reply.text, 'The project has 1,204 lines.');
    assert.equal(published[0]?.reply.deliveryState, 'complete');
    assert.deepEqual(marked, ['turn-child-1']);
  } finally {
    unregister();
  }
});

test('a follow-up is never published twice, also after the native record says so', async () => {
  const { published, unregister, markPublished } = recordingHandlers();
  try {
    const turn = followUpTurn('child-2', directRoute());
    assert.equal(await publishCloudBackgroundFollowUp(turn, { markPublished }), true);
    assert.equal(await publishCloudBackgroundFollowUp(turn, { markPublished }), false);
    // After a reload the in-memory record is gone; the turn says it was published.
    const reloaded = followUpTurn('child-2b', directRoute());
    reloaded.backgroundFollowUp!.published = true;
    assert.equal(await publishCloudBackgroundFollowUp(reloaded, { markPublished }), false);
    assert.equal(published.length, 1);
  } finally {
    unregister();
  }
});

test('a follow-up without a route, a handler or the right account waits for a later pass', async () => {
  const marked: string[] = [];
  const markPublished = async (turnId: string) => { marked.push(turnId); };
  const turn = followUpTurn('child-3', directRoute());
  assert.equal(await publishCloudBackgroundFollowUp(turn, { markPublished }), false, 'no handler mounted yet');
  assert.equal(await publishCloudBackgroundFollowUp(followUpTurn('child-3b', null), { markPublished }), false);
  assert.equal(await publishCloudBackgroundFollowUp(followUpTurn('child-3c', { kind: 'direct' }), { markPublished }), false);

  let signedIn = false;
  const unregister = registerCloudBackgroundFollowUpHandler('direct', async () => signedIn);
  try {
    assert.equal(await publishCloudBackgroundFollowUp(turn, { markPublished }), false, 'signed out');
    signedIn = true;
    assert.equal(await publishCloudBackgroundFollowUp(turn, { markPublished }), true);
    assert.deepEqual(marked, ['turn-child-3']);
  } finally {
    unregister();
  }
  assert.equal(cloudBackgroundFollowUpReply(followUpTurn('none', null, { backgroundFollowUp: null })), null);
});

test('a running follow-up waits for its turn, and a failed publish is retried', async () => {
  let attempts = 0;
  const replies: CloudBackgroundFollowUpReply[] = [];
  const unregister = registerCloudBackgroundFollowUpHandler('direct', async (_route, reply) => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
    replies.push(reply);
    return true;
  });
  try {
    const running = followUpTurn('child-4', directRoute(), {
      completed: false, succeeded: false, status: 'queued', assistantText: '',
    });
    const finished = { ...running, completed: true, succeeded: false, status: 'failed', error: 'Provider unavailable' };
    const options = { waitForTurn: async () => finished, markPublished: async () => undefined };
    assert.equal(await publishCloudBackgroundFollowUp(running, options), false);
    assert.equal(await publishCloudBackgroundFollowUp(running, options), true);
    assert.equal(attempts, 2);
    assert.equal(replies[0]?.deliveryState, 'failed');
    assert.equal(replies[0]?.text, 'Provider unavailable');
  } finally {
    unregister();
  }
});

test('a direct follow-up goes to the parent chat and thread under a stable message id', async () => {
  const sent: { token: string; peerId: string; body: string; options: unknown }[] = [];
  const merged: CloudMessage[] = [];
  const client = {
    sendMessage: async (token: string, peerId: string, body: string, options?: unknown) => {
      sent.push({ token, peerId, body, options });
      return { messageId: 'wire-1' } as CloudMessage;
    },
  };
  const reply = cloudBackgroundFollowUpReply(followUpTurn('child-5', directRoute()))!;
  const publish = () => publishCloudDirectBackgroundFollowUp(
    { client, token: 'token', mergeMessage: (message) => merged.push(message), syncMessages: async () => undefined },
    directRoute(),
    reply,
  );
  await publish();
  await publish();

  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.peerId, 'acct_peer');
  assert.deepEqual(sent[0]?.options, { sessionId: 'session:direct', clientMessageId: 'shared:request-1:background-result:child-5:done' });
  assert.deepEqual(sent[1]?.options, sent[0]?.options, 'a republish reuses the client message id');
  const body = parseCloudAgentResponse(sent[0]!.body)!;
  assert.equal(body.requestId, 'background-result:child-5:done');
  assert.equal(body.text, 'The project has 1,204 lines.');
  assert.equal(body.messageAction?.kind, 'thread');
  assert.equal(body.messageAction?.source.sourceMessageId, 'thread-root');
  assert.equal(merged.length, 2);
});

test('a group route keeps the group and thread but not the request text', () => {
  const participant = { accountId: 'acct_owner', displayName: 'Owner', role: 'admin' };
  const context = {
    account: { accountId: 'acct_owner' },
    envelope: {
      kind: 'group-message', groupId: 'group-1', groupSpaceId: 'space-1', groupTitle: 'Team',
      createdByAccountId: 'acct_owner', actor: participant, participants: [participant],
      message: {
        id: 'request-1', senderAccountId: 'acct_peer', text: 'private request text', createdAtMs: 1,
        attachments: [{ id: 'attachment' }], messageAction: null,
      },
    },
    groupSpaceId: 'space-1',
    participantByAccount: new Map([['acct_owner', participant]]),
  } as unknown as CloudGroupMessageControlContext;

  const route = cloudGroupBackgroundFollowUpRoute({
    context, messageAction: thread, targetAccountIds: ['acct_owner', 'acct_peer'],
    agentId: 'agent-1', agentDisplayName: 'Kordi',
  })!;

  assert.equal(route.kind, 'group');
  assert.equal(route.envelope.groupId, 'group-1');
  assert.equal(route.envelope.message?.id, 'request-1');
  assert.equal(route.envelope.message?.text, '');
  assert.equal(route.envelope.message?.attachments, undefined);
  assert.deepEqual(route.envelope.message?.messageAction, thread);
  assert.deepEqual(route.targetAccountIds, ['acct_owner', 'acct_peer']);
  // The route survives the trip through the native runtime as plain JSON.
  const roundTrip = cloudBackgroundFollowUpRoute(JSON.parse(JSON.stringify(route))) as CloudGroupBackgroundFollowUpRoute;
  assert.equal(roundTrip.kind, 'group');
  assert.equal(roundTrip.envelope.groupId, 'group-1');
  assert.equal(cloudBackgroundFollowUpRoute({ ...route, targetAccountIds: [] }), null);
});

test('a group follow-up goes to the parent group and thread under a stable message id', async () => {
  const participant = { accountId: 'acct_owner', displayName: 'Owner', role: 'admin' };
  const route = cloudBackgroundFollowUpRoute({
    kind: 'group', accountId: 'acct_owner', groupSpaceId: 'space-1', participants: [participant],
    targetAccountIds: ['acct_owner', 'acct_peer'], agentId: 'agent-1', agentDisplayName: 'Kordi',
    envelope: {
      kind: 'group-message', groupId: 'group-1', groupSpaceId: 'space-1', groupTitle: null,
      createdByAccountId: 'acct_owner', actor: participant, participants: [participant],
      message: { id: 'request-1', senderAccountId: 'acct_peer', text: '', createdAtMs: 1, messageAction: thread },
    },
  }) as CloudGroupBackgroundFollowUpRoute;
  const sent: { targetAccountId: string; body: string; options: { clientMessageId?: string; sessionId?: string } }[] = [];
  const client = {
    sendMessage: async (_token: string, targetAccountId: string, body: string, options: { clientMessageId?: string; sessionId?: string }) => {
      sent.push({ targetAccountId, body, options });
      return { messageId: `wire-${sent.length}` } as CloudMessage;
    },
  };
  const runtime = { client, mergeMessage: () => undefined, syncDiff: async () => undefined } as unknown as CloudGroupAgentRuntime;
  const reply = cloudBackgroundFollowUpReply(followUpTurn('child-6', route, { completedAtMs: 10 }))!;
  const publish = () => publishCloudGroupBackgroundFollowUp(
    { account: {
      accountId: 'acct_owner', displayName: 'Owner',
      avatar: { source: 'generated', style: 'beam', seed: 'owner', version: 1 },
    } as unknown as CloudAccount, runtime, policy: {} as CloudGroupAgentPolicy, token: 'token' },
    route,
    reply,
  );
  await publish();
  await publish();

  assert.deepEqual(sent.slice(0, 2).map((entry) => entry.targetAccountId), ['acct_owner', 'acct_peer']);
  assert.equal(sent[0]?.options.sessionId, 'group-1');
  assert.equal(sent[2]?.options.clientMessageId, sent[0]?.options.clientMessageId, 'a republish reuses the client message id');
  const envelope = parseCloudGroupControl(sent[0]!.body)!;
  assert.equal(envelope.groupId, 'group-1');
  assert.equal(envelope.message?.id, 'msg:cloud-agent:turn-child-6');
  assert.equal(envelope.message?.requestId, 'background-result:child-6:done');
  assert.equal(envelope.message?.replyToMessageId, 'request-1');
  assert.equal(envelope.message?.senderAgentId, 'agent-1');
  assert.equal(envelope.message?.messageAction?.kind, 'thread');
  assert.equal(envelope.message?.text, 'The project has 1,204 lines.');
});

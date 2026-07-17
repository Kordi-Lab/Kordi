import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloudGroupAttachmentReferences,
  cloudGroupControlWithAttachmentReferences,
  cloudGroupIdentityRequest,
  cloudGroupAgentResponseTargetAccountIds,
  cloudGroupDeliveryStateFromMessages,
  cloudGroupReadReceiptSummaryFromMessages,
  cloudGroupControlMessagesForAccount,
  cloudGroupLocalAgentRequestAlreadyHandled,
  cloudGroupMessageReadPeerIds,
  cloudGroupMessageReadTargets,
  cloudGroupMessageSessionId,
  cloudGroupUnreadCountsBySessionId,
  cloudGroupPeerIdsFromContactsAndRequests,
  cloudGroupPeerIdsFromMessages,
  cloudGroupParticipantFromContact,
  cloudGroupParticipantsWithProfiles,
  cloudGroupRelatedControlsForSend,
  cloudGroupTargetAccountIds,
  cloudGroupTitleForOutgoingControl,
  cloudGroupUniqueParticipants,
  encodeCloudGroupControl,
  firstCloudGroupSendFailure,
  fulfilledCloudGroupSends,
  isCloudGroupSessionId,
  nonCloudGroupTargets,
  parseCloudGroupControl,
  shouldApplyCloudGroupTitleUpdate,
  shouldCountCloudGroupMessageUnread,
  cloudSessionTitleUpdateTitle,
  cloudGroupTitleUpdateNoticeRequest,
  cloudSessionTitleUpdateNoticeRequest,
  shouldRouteMentionThroughCloudGroup,
  cloudGroupAgentMentionHasResponse,
  cloudGroupAgentMentionResponseState,
  cloudGroupAgentOfflineNoticeRequest,
  cloudGroupAgentRequestingNoticeMessage,
} from '../src/features/cloud/cloudGroupMessages';
import { CLOUD_HOST_SENTINEL } from '../src/features/cloud/useCloudContacts';

test('cloud group control envelopes reject direct contact session ids', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:direct-person:acct_a:acct_b',
    groupTitle: 'Not a group',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg_direct_leak',
      senderAccountId: 'acct_a',
      text: '@KordiProjectDriver hi',
      createdAtMs: 123,
      senderKind: 'human',
    },
  });

  assert.equal(isCloudGroupSessionId('session:direct-person:acct_a:acct_b'), false);
  assert.equal(parseCloudGroupControl(body), null);
  assert.deepEqual(cloudGroupControlMessagesForAccount({ accountId: 'acct_b', messages: [{
    messageId: 'msg_direct_leak_cloud',
    fromAccountId: 'acct_a',
    toAccountId: 'acct_b',
    body,
    createdAt: '2026-06-23T00:00:00Z',
    deliveredAt: null,
    readAt: null,
    direction: 'incoming',
    sessionId: 'session:direct-person:acct_a:acct_b',
  }] }), []);
});

test('cloud group control envelopes round trip and stay identifiable', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: 'data:image/jpeg;base64,bob', role: 'person' },
    ],
    message: {
      id: 'msg_1',
      senderAccountId: 'acct_a',
      text: 'hello group',
      createdAtMs: 123,
      senderKind: 'agent',
      senderDisplayName: 'Agent',
      deliveryState: 'processing',
      replyToMessageId: 'msg_request',
      requestId: 'msg_request',
      targetCloudAgentId: 'cloud_agent_project',
      targetCloudAgentName: 'Project Driver',
      targetCloudAgentOwnerAccountId: 'acct_owner',
      targetCloudAgentOwnerName: 'Shuyang',
    },
  });

  const parsed = parseCloudGroupControl(body);
  assert.equal(parsed?.kind, 'group-message');
  assert.equal(parsed?.groupId, 'session:group:one');
  assert.equal(parsed?.participants[1]?.avatarUrl, 'data:image/jpeg;base64,bob');
  assert.equal(parsed?.message?.text, 'hello group');
  assert.equal(parsed?.message?.senderKind, 'agent');
  assert.equal(parsed?.message?.senderDisplayName, 'Agent');
  assert.equal(parsed?.message?.deliveryState, 'processing');
  assert.equal(parsed?.message?.replyToMessageId, 'msg_request');
  assert.equal(parsed?.message?.requestId, 'msg_request');
  assert.equal(parsed?.message?.targetCloudAgentId, 'cloud_agent_project');
  assert.equal(parsed?.message?.targetCloudAgentName, 'Project Driver');
  assert.equal(parsed?.message?.targetCloudAgentOwnerAccountId, 'acct_owner');
  assert.equal(parsed?.message?.targetCloudAgentOwnerName, 'Shuyang');
});

test('cloud group control envelopes preserve quote message actions for recipients', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:quote',
    groupTitle: 'Team',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg_reply',
      senderAccountId: 'acct_a',
      text: 'hi',
      createdAtMs: 123,
      messageAction: {
        schemaVersion: 1,
        kind: 'quote',
        source: {
          sourceSessionId: 'session:group:quote',
          sourceMessageId: 'msg_source',
          sourceMessageKind: 'text',
          senderLabel: 'Bob',
          textPreview: 'hey everyone',
          attachmentCount: 0,
          timeLabel: '00:48',
        },
      },
    },
  });

  const parsed = parseCloudGroupControl(body);
  assert.equal(parsed?.message?.messageAction?.kind, 'quote');
  assert.equal(parsed?.message?.messageAction?.source.sourceMessageId, 'msg_source');
  assert.equal(parsed?.message?.messageAction?.source.senderLabel, 'Bob');
  assert.equal(parsed?.message?.messageAction?.source.textPreview, 'hey everyone');
});

test('cloud group control envelopes round trip attachments', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:attachments',
    groupTitle: null,
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' }],
    message: {
      id: 'msg_1',
      senderAccountId: 'acct_a',
      text: '',
      createdAtMs: 123,
      attachments: [{
        attachmentId: 'att_1',
        name: 'image.png',
        kind: 'image',
        mimeType: 'image/png',
        sizeBytes: 1234,
        downloadUrl: 'https://files.test/att_1',
        previewUrl: 'https://files.test/att_1',
      }],
    },
  });

  const parsed = parseCloudGroupControl(body);
  assert.deepEqual(parsed?.message?.attachments, [{
    attachmentId: 'att_1',
    name: 'image.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 1234,
    downloadUrl: 'https://files.test/att_1',
    previewUrl: 'https://files.test/att_1',
  }]);
});

test('group attachment previews stay outside the size-limited control envelope', () => {
  const previewUrl = `data:image/webp;base64,${'a'.repeat(20_000)}`;
  const uploadedAttachments = [{
    attachmentId: 'att_large_preview',
    name: 'image.png',
    kind: 'image' as const,
    mimeType: 'image/png',
    sizeBytes: 1234,
    previewUrl,
  }];
  const attachmentReferences = cloudGroupAttachmentReferences(uploadedAttachments);
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:attachments',
    groupTitle: null,
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' }],
    message: {
      id: 'msg_1',
      senderAccountId: 'acct_a',
      text: '',
      createdAtMs: 123,
      attachments: attachmentReferences,
    },
  });

  assert.equal(attachmentReferences[0]?.previewUrl, undefined);
  assert.ok(body.length < 4_000, `control envelope was ${body.length} characters`);
  assert.equal(parseCloudGroupControl(body)?.message?.attachments?.[0]?.previewUrl, null);
});

test('uploaded attachment references replace the durable pre-upload group payload', () => {
  const pendingBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:attachments',
    groupTitle: 'Design',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' }],
    message: {
      id: 'msg_pending_upload',
      senderAccountId: 'acct_a',
      text: 'review this',
      createdAtMs: 123,
      targetCloudAgentId: 'agent_design',
    },
  });

  const uploadedBody = cloudGroupControlWithAttachmentReferences(pendingBody, [{
    attachmentId: 'att_uploaded',
    name: 'mockup.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 512,
  }]);
  const parsed = parseCloudGroupControl(uploadedBody);

  assert.equal(parsed?.message?.id, 'msg_pending_upload');
  assert.equal(parsed?.message?.text, 'review this');
  assert.equal(parsed?.message?.targetCloudAgentId, 'agent_design');
  assert.deepEqual(parsed?.message?.attachments, [{
    attachmentId: 'att_uploaded',
    name: 'mockup.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 512,
    downloadUrl: null,
    previewUrl: null,
  }]);
});

test('cloud group related controls match continuations by shared group space id', () => {
  const rootEnvelope = {
    kind: 'group-invite' as const,
    groupId: 'session:group:root',
    groupSpaceId: 'session:group:root',
    groupTitle: '1111',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: 'https://images.test/alice.png', role: 'admin' as const },
    participants: [
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: 'https://images.test/alice.png', role: 'admin' as const },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: 'https://images.test/bob.png', role: 'person' as const },
    ],
    message: null,
  };

  const related = cloudGroupRelatedControlsForSend([
    { envelope: rootEnvelope, createdAtMs: 1 },
  ], { groupId: 'session:group:child', groupSpaceId: 'session:group:root' });

  assert.equal(related.length, 1);
  assert.equal(related[0]?.envelope.groupTitle, '1111');
  assert.equal(related[0]?.envelope.participants[1]?.avatarUrl, 'https://images.test/bob.png');
});

test('cloud group participant merge preserves later real avatar urls', () => {
  assert.deepEqual(cloudGroupUniqueParticipants([
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: 'https://images.test/a.png', role: 'person' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: 'https://images.test/b.png', role: 'person' },
  ]), [
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: 'https://images.test/a.png', role: 'person' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: 'https://images.test/b.png', role: 'person' },
  ]);
});

test('cloud group participant envelopes drop local-only ids, huge data avatars, and legacy pixel avatars', () => {
  assert.deepEqual(cloudGroupUniqueParticipants([
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: 'data:image/jpeg;base64,'.padEnd(5000, 'x'), role: 'admin' },
    { accountId: 'kh_local_human', displayName: 'Local Human', avatarUrl: null, role: 'self' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: 'kordi-pixel-avatar://cloud-signup:seed', role: 'person' },
  ]), [
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
  ]);
});

test('cloud group participant normalization rejects kh local ids', () => {
  const participants = cloudGroupUniqueParticipants([
    { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    { accountId: 'kh_local', displayName: 'Localhost', avatarUrl: null, role: 'person' },
    { accountId: 'node_local', displayName: 'Node', avatarUrl: null, role: 'person' },
    { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
  ]);

  assert.deepEqual(participants.map((participant) => participant.accountId), ['acct_a', 'acct_b']);
});

test('cloud group messages carry concrete session id separately from shared group space id', () => {
  assert.equal(cloudGroupMessageSessionId({
    activeConvCanonicalSessionId: 'session:group:child-session',
    activeGroupSessionSpaceId: 'session:group:original-space',
  }), 'session:group:child-session');

  const parsed = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child-session',
    groupSpaceId: 'session:group:original-space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    participants: [{ accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' }],
    message: { id: 'msg_1', senderAccountId: 'acct_a', text: 'hello child', createdAtMs: 123 },
  }));

  assert.equal(parsed?.groupId, 'session:group:child-session');
  assert.equal(parsed?.groupSpaceId, 'session:group:original-space');
});

test('cloud group delivery status becomes read when any recipient has read the outbound message', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' }],
    message: { id: 'msg_group_1', senderAccountId: 'acct_me', text: 'hello', createdAtMs: 1 },
  });

  assert.equal(cloudGroupDeliveryStateFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_group_1',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_me', toAccountId: 'acct_peer_a', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: '2026-05-11T00:00:01Z', readAt: null, direction: 'outgoing' },
      { messageId: 'cloud_2', fromAccountId: 'acct_me', toAccountId: 'acct_peer_b', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: '2026-05-11T00:00:01Z', readAt: '2026-05-11T00:00:02Z', direction: 'outgoing' },
    ],
  }), 'read');

  assert.equal(cloudGroupDeliveryStateFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_group_1',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_me', toAccountId: 'acct_peer_a', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: '2026-05-11T00:00:01Z', readAt: '2026-05-11T00:00:02Z', direction: 'outgoing' },
      { messageId: 'cloud_2', fromAccountId: 'acct_me', toAccountId: 'acct_peer_b', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: '2026-05-11T00:00:01Z', readAt: '2026-05-11T00:00:03Z', direction: 'outgoing' },
    ],
  }), 'read');
});

test('cloudGroupReadReceiptSummaryFromMessages returns only recipients who read the outbound group message', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:test',
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg_1',
      text: 'hello',
      senderAccountId: 'acct_me',
      senderDisplayName: 'Me',
      createdAt: '2026-06-06T12:00:00Z',
    },
  });

  const summary = cloudGroupReadReceiptSummaryFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_1',
    messages: [
      {
        messageId: 'copy_1',
        fromAccountId: 'acct_me',
        toAccountId: 'acct_a',
        body,
        createdAt: '2026-06-06T12:00:00Z',
        deliveredAt: '2026-06-06T12:00:01Z',
        readAt: '2026-06-06T12:00:02Z',
        direction: 'outgoing',
      },
      {
        messageId: 'copy_2',
        fromAccountId: 'acct_me',
        toAccountId: 'acct_b',
        body,
        createdAt: '2026-06-06T12:00:00Z',
        deliveredAt: '2026-06-06T12:00:01Z',
        readAt: null,
        direction: 'outgoing',
      },
    ],
  });

  assert.deepEqual(summary, {
    count: 1,
    participants: [{ accountId: 'acct_a', identityId: 'human:acct_a', readAt: '2026-06-06T12:00:02Z' }],
  });
});

test('cloudGroupReadReceiptSummaryFromMessages returns null when no recipients have read', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:test',
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg_1',
      text: 'hello',
      senderAccountId: 'acct_me',
      senderDisplayName: 'Me',
      createdAt: '2026-06-06T12:00:00Z',
    },
  });

  const summary = cloudGroupReadReceiptSummaryFromMessages({
    accountId: 'acct_me',
    messageId: 'msg_1',
    messages: [{
      messageId: 'copy_1',
      fromAccountId: 'acct_me',
      toAccountId: 'acct_a',
      body,
      createdAt: '2026-06-06T12:00:00Z',
      deliveredAt: '2026-06-06T12:00:01Z',
      readAt: null,
      direction: 'outgoing',
    }],
  });

  assert.equal(summary, null);
});

test('cloud group peer discovery expands beyond direct contacts from existing controls', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-invite',
    groupId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_b',
    actor: { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
      { accountId: 'acct_c', displayName: 'Carol', avatarUrl: null, role: 'person' },
    ],
  });

  assert.deepEqual(cloudGroupPeerIdsFromMessages({
    accountId: 'acct_me',
    contactPeerIds: ['acct_b'],
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_b', toAccountId: 'acct_me', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), ['acct_b', 'acct_c']);
});

test('cloud group peer discovery can bootstrap from contact request counterparts', () => {
  assert.deepEqual(cloudGroupPeerIdsFromContactsAndRequests({
    accountId: 'acct_me',
    contactPeerIds: ['acct_b'],
    contacts: [{ accountId: 'acct_c' }],
    requests: [{ requesterNodeId: 'acct_d', targetNodeId: 'acct_me' }],
  }), ['acct_b', 'acct_c', 'acct_d']);
});

test('cloud group replay includes self-authored controls after local reset', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:self-authored',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: { id: 'msg:ui:self', senderAccountId: 'acct_me', text: 'hello from me', createdAtMs: 1 },
  });

  const replay = cloudGroupControlMessagesForAccount({
    accountId: 'acct_me',
    messages: [
      { messageId: 'cloud_self', fromAccountId: 'acct_me', toAccountId: 'acct_peer', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'outgoing' },
    ],
  });

  assert.deepEqual(replay.map((message) => message.messageId), ['cloud_self']);
});

test('cloud group messages do not inherit stale group titles from earlier rename controls', () => {
  assert.equal(cloudGroupTitleForOutgoingControl({
    kind: 'group-message',
    groupTitle: null,
    relatedGroupTitles: ['Lalla'],
  }), null);
  assert.equal(cloudGroupTitleForOutgoingControl({
    kind: 'group-title-update',
    groupTitle: 'Lalla',
    relatedGroupTitles: [],
  }), 'Lalla');
});

test('only explicit group title update controls mutate the shared group name', () => {
  assert.equal(shouldApplyCloudGroupTitleUpdate({ kind: 'group-message', groupTitle: 'Stale name' }), false);
  assert.equal(shouldApplyCloudGroupTitleUpdate({ kind: 'session-title-update', groupTitle: 'Thread title' }), false);
  assert.equal(shouldApplyCloudGroupTitleUpdate({ kind: 'group-title-update', groupTitle: 'Lalla' }), true);
  assert.equal(cloudSessionTitleUpdateTitle({ kind: 'session-title-update', groupTitle: 'Thread title' }), 'Thread title');
  assert.equal(cloudSessionTitleUpdateTitle({ kind: 'group-title-update', groupTitle: 'Lalla' }), null);
});

test('group title updates build a remote visible group rename notice separately from session titles', () => {
  const request = cloudGroupTitleUpdateNoticeRequest({
    envelope: {
      kind: 'group-title-update',
      groupId: 'session:group:cloud',
      groupSpaceId: 'space:cloud',
      groupTitle: 'Good group',
      createdByAccountId: 'acct_sender',
      actor: { accountId: 'acct_sender', displayName: '杨谢', avatarUrl: null },
      participants: [{ accountId: 'acct_sender', displayName: '杨谢', avatarUrl: null }],
      message: null,
    },
    actorIdentityId: 'human:cloud:acct_sender',
    createdAtMs: 1234,
    cloudMessageId: 'cloud-msg-group-rename',
  });

  assert.equal(request?.id, 'cloud-group-title-notice:cloud-msg-group-rename');
  assert.equal(request?.sessionId, 'session:group:cloud');
  assert.equal(request?.contentText, '杨谢 changed the group name to Good group');
  assert.deepEqual(request?.content, {
    kind: 'group-title-update',
    scope: 'group',
    title: 'Good group',
    actorDisplayName: '杨谢',
  });
});

test('session title updates build a remote visible rename notice without changing group metadata', () => {
  const request = cloudSessionTitleUpdateNoticeRequest({
    envelope: {
      kind: 'session-title-update',
      groupId: 'session:group:cloud',
      groupSpaceId: 'space:cloud',
      groupTitle: 'Sprint follow-up',
      createdByAccountId: 'acct_sender',
      actor: { accountId: 'acct_sender', displayName: '杨谢', avatarUrl: null },
      participants: [{ accountId: 'acct_sender', displayName: '杨谢', avatarUrl: null }],
      message: null,
    },
    actorIdentityId: 'human:cloud:acct_sender',
    createdAtMs: 1234,
    cloudMessageId: 'cloud-msg-rename',
  });

  assert.equal(request?.id, 'cloud-session-title-notice:cloud-msg-rename');
  assert.equal(request?.sessionId, 'session:group:cloud');
  assert.equal(request?.senderRole, 'system');
  assert.equal(request?.messageKind, 'status');
  assert.equal(request?.contentText, '杨谢 changed the session name to Sprint follow-up');
  assert.deepEqual(request?.content, {
    kind: 'session-title-update',
    scope: 'session',
    title: 'Sprint follow-up',
    actorDisplayName: '杨谢',
  });
});

test('cloud group detects whether an offline candidate already sent an agent response', () => {
  assert.equal(cloudGroupAgentMentionHasResponse({
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_target',
    messages: [
      { id: 'msg_processing', sessionId: 'session:group:one', senderIdentityId: 'agent:cloud:acct_target', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { requestId: 'msg_request', deliveryState: 'processing' }, parentMessageId: 'msg_request', status: 'processing', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group-agent' },
    ],
  }), true);
  assert.equal(cloudGroupAgentMentionResponseState({
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_target',
    messages: [
      { id: 'msg_processing', sessionId: 'session:group:one', senderIdentityId: 'agent:cloud:acct_target', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { requestId: 'msg_request', deliveryState: 'processing' }, parentMessageId: 'msg_request', status: 'processing', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group-agent' },
    ],
  }), 'processing');
  assert.equal(cloudGroupAgentMentionResponseState({
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_target',
    messages: [
      { id: 'msg_final', sessionId: 'session:group:one', senderIdentityId: 'agent:cloud:acct_target', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'done', content: { requestId: 'msg_request', deliveryState: 'complete' }, parentMessageId: 'msg_request', status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, sourceTransport: 'cloud-group-agent' },
    ],
  }), 'terminal');

  assert.equal(cloudGroupAgentMentionHasResponse({
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_target',
    messages: [
      { id: 'msg_other', sessionId: 'session:group:one', senderIdentityId: 'agent:cloud:acct_other', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { requestId: 'msg_request', deliveryState: 'processing' }, parentMessageId: 'msg_request', status: 'processing', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group-agent' },
    ],
  }), false);
});

test('cloud group requesting notice uses the final response slot for smooth in-place updates', () => {
  const message = cloudGroupAgentRequestingNoticeMessage({
    sessionId: 'session:group:one',
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_yang',
    targetAgentDisplayName: "杨涛's Kordi",
    createdAtMs: 123,
    sequenceNum: 9,
  });

  assert.equal(message.id, 'msg:cloud-agent-processing:msg_request:acct_yang');
  assert.equal(message.senderIdentityId, 'agent:cloud:acct_yang');
  assert.equal(message.contentText, 'processing...');
  assert.equal(message.status, 'processing');
  assert.equal(message.sourceTransport, 'cloud-group-agent-offline');
  assert.deepEqual(message.content, {
    sender: "杨涛's Kordi",
    timestampMs: 123,
    deliveryState: 'processing',
    requestId: 'msg_request',
    replyToMessageId: 'msg_request',
  });
});

test('cloud group offline notice replies as the mentioned agent and marks the turn failed', () => {
  const request = cloudGroupAgentOfflineNoticeRequest({
    sessionId: 'session:group:one',
    requestMessageId: 'msg_request',
    targetAccountId: 'acct_yang',
    targetHumanDisplayName: '杨涛',
    createdAtMs: 123,
  });

  assert.equal(request.id, 'msg:cloud-agent-offline:msg_request:acct_yang');
  assert.equal(request.senderIdentityId, 'agent:cloud:acct_yang');
  assert.equal(request.senderRole, 'external-agent');
  assert.equal(request.messageKind, 'agent-turn');
  assert.equal(request.contentText, '');
  assert.equal(request.parentMessageId, 'msg_request');
  assert.equal(request.status, 'failed');
  assert.deepEqual(request.content, {
    sender: "杨涛's Kordi",
    timestampMs: 123,
    deliveryState: 'failed',
    requestId: 'msg_request',
    replyToMessageId: 'msg_request',
    error: "杨涛 and 杨涛's Kordi are offline.",
  });
});

test('cloud group agent response state prefers terminal rows over older processing placeholders', () => {
  const groupId = 'session:group:one';
  const requestId = 'msg_request';
  const targetAccountId = 'acct_target';
  assert.equal(cloudGroupAgentMentionResponseState({
    requestMessageId: requestId,
    targetAccountId,
    messages: [
      { id: 'msg_processing', sessionId: groupId, senderIdentityId: 'agent:cloud:acct_target', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'processing...', content: { requestId, deliveryState: 'processing' }, parentMessageId: requestId, status: 'processing', sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'cloud-group-agent' },
      { id: 'msg_final', sessionId: groupId, senderIdentityId: 'agent:cloud:acct_target', senderRole: 'external-agent', messageKind: 'agent-turn', contentText: 'final answer', content: { requestId, deliveryState: 'complete' }, parentMessageId: requestId, status: 'complete', sequenceNum: 2, createdAtMs: 2, updatedAtMs: 2, sourceTransport: 'cloud-group-agent' },
    ],
  }), 'terminal');
});

test('cloud group local agent requests are considered handled after a synced processing or final response', () => {
  const requestId = 'msg_request';
  const responseBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_a',
    actor: { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_a', displayName: 'Alice', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_b', displayName: 'Bob', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg_response',
      senderAccountId: 'acct_a',
      text: 'done',
      createdAtMs: 200,
      senderKind: 'agent',
      deliveryState: 'complete',
      requestId,
      replyToMessageId: requestId,
    },
  });

  assert.equal(cloudGroupLocalAgentRequestAlreadyHandled({
    localAccountId: 'acct_a',
    requestMessageId: requestId,
    messages: [{
      messageId: 'cloud_response',
      fromAccountId: 'acct_a',
      toAccountId: 'acct_b',
      body: responseBody,
      createdAt: new Date(200).toISOString(),
      deliveredAt: null,
      readAt: null,
      direction: 'outgoing',
    }],
  }), true);
});

test('cloud group replay deduplicates fanout rows for the same canonical message', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:fanout',
    groupTitle: null,
    createdByAccountId: 'acct_me',
    actor: { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' },
      { accountId: 'acct_a', displayName: 'A', avatarUrl: null, role: 'person' },
      { accountId: 'acct_b', displayName: 'B', avatarUrl: null, role: 'person' },
    ],
    message: { id: 'msg:ui:fanout', senderAccountId: 'acct_me', text: 'hello both', createdAtMs: 1 },
  });

  const replay = cloudGroupControlMessagesForAccount({
    accountId: 'acct_me',
    messages: [
      { messageId: 'cloud_to_a', fromAccountId: 'acct_me', toAccountId: 'acct_a', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'outgoing' },
      { messageId: 'cloud_to_b', fromAccountId: 'acct_me', toAccountId: 'acct_b', body, createdAt: '2026-05-11T00:00:01Z', deliveredAt: null, readAt: null, direction: 'outgoing' },
    ],
  });

  assert.deepEqual(replay.map((message) => message.messageId), ['cloud_to_a']);
});

test('cloud group agent response targets include original sender even when participant snapshot is incomplete', () => {
  const envelope = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:one',
    groupTitle: 'Team',
    createdByAccountId: 'acct_requester',
    actor: { accountId: 'acct_requester', displayName: 'Requester', avatarUrl: null, role: 'person' },
    // Regression: older/incomplete controls may only carry the owner in participants.
    participants: [{ accountId: 'acct_owner', displayName: 'Owner', avatarUrl: null, role: 'person' }],
    message: { id: 'msg_request', senderAccountId: 'acct_requester', text: '@OwnersKordi help', createdAtMs: 1 },
  }));

  assert.ok(envelope);
  assert.deepEqual(cloudGroupAgentResponseTargetAccountIds({
    localAccountId: 'acct_owner',
    envelope,
    requestCloudMessage: { fromAccountId: 'acct_requester', toAccountId: 'acct_owner' },
  }), ['acct_requester']);
});

test('cloud group read helper marks inbound controls read when their group session is open', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' }],
    message: { id: 'msg_group_1', senderAccountId: 'acct_peer', text: 'hello', createdAtMs: 1 },
  });

  assert.deepEqual(cloudGroupMessageReadPeerIds({
    accountId: 'acct_me',
    activeConversationId: 'session:group:child',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), ['acct_peer']);
});

test('cloud group read helper returns active session ids for durable Cloud read receipts', () => {
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [{ accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'person' }],
    message: { id: 'msg_group_1', senderAccountId: 'acct_peer', text: 'hello', createdAtMs: 1 },
  });

  assert.deepEqual(cloudGroupMessageReadTargets({
    accountId: 'acct_me',
    activeConversationIds: ['ui-row-id', 'group:session:group:space'],
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), { peerIds: ['acct_peer'], sessionIds: ['session:group:child'] });
});

test('cloud group unread helper counts only hidden sessions', () => {
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationId: 'session:group:child', groupId: 'session:group:child', groupSpaceId: 'session:group:space' }), false);
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationId: 'session:group:space', groupId: 'session:group:child', groupSpaceId: 'session:group:space' }), false);
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationIds: ['ui-row-id', 'group:session:group:space'], groupId: 'session:group:child', groupSpaceId: 'session:group:space' }), false);
  assert.equal(shouldCountCloudGroupMessageUnread({ activeConversationId: 'session:group:other', groupId: 'session:group:child', groupSpaceId: 'session:group:space' }), true);
});

test('cloud group unread count helper ignores messages at or before local read cursor', () => {
  const readMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg:read',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'Already read but stale cache says unread',
      createdAtMs: 10,
    },
  });
  const unreadMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg:unread',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'New unread after cursor',
      createdAtMs: 11,
    },
  });

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId: 'acct_me',
    activeConversationId: 'session:outside',
    readCursorsBySessionId: {
      'session:group:child': { lastReadMessageId: 'msg:read', lastReadCreatedAtMs: 10 },
    },
    messages: [
      { messageId: 'cloud_read_stale', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: readMessage, createdAt: '2026-05-11T00:00:10Z', deliveredAt: null, readAt: null, direction: 'incoming' },
      { messageId: 'cloud_unread_new', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: unreadMessage, createdAt: '2026-05-11T00:00:11Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), { 'session:group:child': 1 });

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId: 'acct_me',
    activeConversationId: 'session:outside',
    readCursorsBySessionId: {
      'session:group:child': { lastReadMessageId: 'msg:unread', lastReadCreatedAtMs: 11 },
    },
    messages: [
      { messageId: 'cloud_read_stale', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: readMessage, createdAt: '2026-05-11T00:00:10Z', deliveredAt: null, readAt: null, direction: 'incoming' },
      { messageId: 'cloud_unread_new', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: unreadMessage, createdAt: '2026-05-11T00:00:11Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), {});
});

test('cloud group unread helper ignores self-authored cached controls even when direction is stale incoming', () => {
  const accountId = 'acct_self';
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:self-cache',
    groupSpaceId: 'session:group:self-cache',
    groupTitle: 'Self cache',
    createdByAccountId: accountId,
    actor: { accountId, displayName: 'Me', avatarUrl: null, role: 'admin' },
    participants: [{ accountId, displayName: 'Me', avatarUrl: null, role: 'admin' }],
    message: {
      id: 'msg_self_group',
      senderAccountId: accountId,
      text: 'hello',
      createdAtMs: 1783440000000,
      senderKind: 'human',
    },
  });

  const unread = cloudGroupUnreadCountsBySessionId({
    accountId,
    messages: [{
      messageId: 'cloud_msg_self_group',
      fromAccountId: accountId,
      toAccountId: accountId,
      body,
      createdAt: '2026-07-07T18:00:00Z',
      deliveredAt: '2026-07-07T18:00:00Z',
      readAt: null,
      direction: 'incoming',
      sessionId: 'session:group:self-cache',
    }],
  });

  assert.deepEqual(unread, {});
});

test('cloud group unread count helper deduplicates inbound unread controls per hidden session', () => {
  const groupMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:child',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg:one',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'Unread group hello',
      createdAt: '2026-05-11T00:00:00Z',
    },
  });
  const secondGroupMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:group:other',
    groupSpaceId: 'session:group:space',
    groupTitle: 'Team',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    message: {
      id: 'msg:two',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'Another unread group hello',
      createdAt: '2026-05-11T00:00:01Z',
    },
  });

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId: 'acct_me',
    activeConversationId: 'session:outside',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: groupMessage, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
      { messageId: 'cloud_1_duplicate', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: groupMessage, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
      { messageId: 'cloud_read', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: secondGroupMessage, createdAt: '2026-05-11T00:00:01Z', deliveredAt: null, readAt: '2026-05-11T00:00:02Z', direction: 'incoming' },
      { messageId: 'cloud_outgoing', fromAccountId: 'acct_me', toAccountId: 'acct_peer', body: groupMessage, createdAt: '2026-05-11T00:00:03Z', deliveredAt: null, readAt: null, direction: 'outgoing' },
    ],
  }), { 'session:group:child': 1 });

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId: 'acct_me',
    activeConversationId: 'session:group:space',
    messages: [
      { messageId: 'cloud_1', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: groupMessage, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), {});
});

test('cloud group unread count helper ignores inherited fork snapshots and counts only new fork messages', () => {
  const forkSnapshotMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:fork:child',
    groupSpaceId: 'session:fork:child',
    groupTitle: 'Fork',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    fork: {
      forkSessionId: 'session:fork:child',
      parentSessionId: 'session:group:parent',
      parentMessageId: 'msg:parent',
      createdAtMs: 1,
    },
    message: {
      id: 'msg:old-snapshot',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'Inherited old message',
      createdAtMs: 1,
      forkSnapshot: true,
    },
  });
  const newForkMessage = encodeCloudGroupControl({
    kind: 'group-message',
    groupId: 'session:fork:child',
    groupSpaceId: 'session:fork:child',
    groupTitle: 'Fork',
    createdByAccountId: 'acct_peer',
    actor: { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    participants: [
      { accountId: 'acct_me', displayName: 'Me', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' },
    ],
    fork: {
      forkSessionId: 'session:fork:child',
      parentSessionId: 'session:group:parent',
      parentMessageId: 'msg:parent',
      createdAtMs: 1,
    },
    message: {
      id: 'msg:new-after-fork',
      senderAccountId: 'acct_peer',
      senderDisplayName: 'Peer',
      senderKind: 'human',
      text: 'New message after fork',
      createdAtMs: 2,
    },
  });

  assert.deepEqual(cloudGroupUnreadCountsBySessionId({
    accountId: 'acct_me',
    activeConversationId: 'session:outside',
    messages: [
      { messageId: 'cloud_snapshot', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: forkSnapshotMessage, createdAt: '2026-05-11T00:00:00Z', deliveredAt: null, readAt: null, direction: 'incoming' },
      { messageId: 'cloud_new', fromAccountId: 'acct_peer', toAccountId: 'acct_me', body: newForkMessage, createdAt: '2026-05-11T00:00:01Z', deliveredAt: null, readAt: null, direction: 'incoming' },
    ],
  }), { 'session:fork:child': 1 });
});

test('cloud group send helpers treat partial recipient success as a send success', () => {
  const results: PromiseSettledResult<string>[] = [
    { status: 'fulfilled', value: 'msg_ok' },
    { status: 'rejected', reason: new Error('not contacts') },
  ];

  assert.deepEqual(fulfilledCloudGroupSends(results), ['msg_ok']);
  assert.equal(firstCloudGroupSendFailure(results) instanceof Error, true);
});

test('cloud agent mentions inside cloud groups stay on cloud group transport', () => {
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'cloud', activeGroupSessionIsGroup: true }), true);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true }), false);
  assert.equal(shouldRouteMentionThroughCloudGroup({ activeGroupSessionIsGroup: true, hasCloudGroupRecipients: true }), true);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true, mentionsLocalAgent: true }), true);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true, mentionsBridgeAgent: true, hasCloudGroupRecipients: true }), true);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'host-local', activeGroupSessionIsGroup: true, mentionsBridgeAgent: true, hasCloudGroupRecipients: false }), false);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'cloud', activeGroupSessionIsGroup: false, mentionsLocalAgent: true }), false);
  assert.equal(shouldRouteMentionThroughCloudGroup({ mentionedHostId: 'cloud', activeGroupSessionIsGroup: false, mentionsBridgeAgent: true, hasCloudGroupRecipients: true }), false);
});

test('cloud group helpers split cloud recipients from bridge recipients', () => {
  const targets = [
    { hostId: CLOUD_HOST_SENTINEL, nodeId: 'acct_b' },
    { hostId: 'local-bridge', nodeId: 'node_c' },
  ];

  assert.deepEqual(cloudGroupTargetAccountIds(targets), ['acct_b']);
  assert.deepEqual(nonCloudGroupTargets(targets), [{ hostId: 'local-bridge', nodeId: 'node_c' }]);
});

test('cloud group profile hydration preserves large stored signup avatar images', () => {
  const avatarUrl = `data:image/png;base64,${'a'.repeat(100_000)}`;
  const participants = cloudGroupParticipantsWithProfiles(
    [{ accountId: 'acct_peer', displayName: 'Peer', avatarUrl: null, role: 'person' }],
    [{ accountId: 'acct_peer', displayName: 'Korditest', avatarUrl }],
  );

  assert.equal(participants[0]?.displayName, 'Korditest');
  assert.equal(participants[0]?.avatarUrl, avatarUrl);
});

test('cloud group self identity uses the stable cloud account id and uploaded avatar image', () => {
  const request = cloudGroupIdentityRequest(
    {
      accountId: 'acct_self',
      displayName: 'Self',
      avatarUrl: 'data:image/jpeg;base64,self',
      role: 'self',
    },
    {
      accountId: 'acct_self',
      displayName: 'Self',
      primaryEmail: 'self@example.com',
      avatarUrl: 'data:image/jpeg;base64,self',
      nodeId: null,
      passwordSet: true,
    },
    'human:local-profile',
  );

  assert.equal(request.id, 'human:acct_self');
  assert.equal(request.humanId, 'acct_self');
  assert.equal(request.avatarKey, 'acct_self');
});

test('cloud group contact participant does not synthesize generated avatar urls', () => {
  const participant = cloudGroupParticipantFromContact({
    id: 'cloud:acct_b',
    name: 'Bob',
    initials: 'BO',
    classType: 'other-users',
    entityType: 'user',
    subtitle: 'acct_b',
    bridges: [CLOUD_HOST_SENTINEL],
    status: 'online',
    discoverableOn: [CLOUD_HOST_SENTINEL],
    detail: 'acct_b',
    owner: 'Bob',
    bridgeHostId: CLOUD_HOST_SENTINEL,
    bridgePeerNodeId: 'acct_b',
    bridgeHumanId: 'acct_b',
    bridgeContactStatus: 'accepted',
    avatarSeed: 'bob-seed',
    profileImageUrl: null,
  });

  assert.equal(participant?.avatarUrl, null);
});

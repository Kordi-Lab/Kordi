import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudGroupAttachmentReferences, cloudGroupAdminAccountIds, cloudGroupControlWithAttachmentReferences, cloudGroupControlMessagesForAccount, cloudGroupOutgoingParticipantSnapshot, cloudGroupParticipantsForCollaborationSession, cloudGroupRelatedControlsForSend, encodeCloudGroupControl, isCloudGroupSessionId, parseCloudGroupControl } from '../src/features/cloud/cloudGroupMessages';

test('group admin snapshots always keep the creator and explicit promoted admins', () => {
  const envelope = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-update',
    groupId: 'session:group:admins',
    groupSpaceId: 'session:group:admins',
    groupTitle: 'Admins',
    createdByAccountId: 'acct_creator',
    actor: { accountId: 'acct_creator', displayName: 'Creator', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_creator', displayName: 'Creator', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_promoted', displayName: 'Promoted', avatarUrl: null, role: 'admin' },
      { accountId: 'acct_member', displayName: 'Member', avatarUrl: null, role: 'person' },
    ],
    message: null,
  }));

  assert.ok(envelope);
  assert.deepEqual(cloudGroupAdminAccountIds(envelope!), ['acct_creator', 'acct_promoted']);
});

test('group member removals survive envelope validation and stay scoped to group updates', () => {
  const base = {
    groupId: 'session:group:members',
    groupSpaceId: 'session:group:members',
    groupTitle: 'Members',
    createdByAccountId: 'acct_creator',
    actor: { accountId: 'acct_creator', displayName: 'Creator', avatarUrl: null, role: 'admin' },
    participants: [
      { accountId: 'acct_creator', displayName: 'Creator', avatarUrl: null, role: 'admin' },
    ],
    memberLeaves: [{ eventId: 'leave_member_1', accountId: 'acct_removed', createdAtMs: 1234 }],
    message: null,
  };
  const update = parseCloudGroupControl(encodeCloudGroupControl({
    ...base,
    kind: 'group-update',
  }));
  const message = parseCloudGroupControl(encodeCloudGroupControl({
    ...base,
    kind: 'group-message',
    message: {
      id: 'msg:member-snapshot',
      senderAccountId: 'acct_creator',
      text: 'hello',
      createdAtMs: 1235,
    },
  }));

  assert.deepEqual(update?.memberLeaves, [
    { eventId: 'leave_member_1', accountId: 'acct_removed', createdAtMs: 1234 },
  ]);
  assert.equal(message?.memberLeaves, undefined);
});

test('explicit outgoing membership snapshots do not resurrect historical recipients', () => {
  const currentParticipants = [
    { accountId: 'acct_creator', displayName: 'Creator', avatarUrl: null, role: 'admin' },
    { accountId: 'acct_remaining', displayName: 'Remaining', avatarUrl: null, role: 'person' },
  ];
  const historicalParticipants = [
    ...currentParticipants,
    { accountId: 'acct_removed', displayName: 'Removed', avatarUrl: null, role: 'person' },
  ];

  assert.deepEqual(
    cloudGroupOutgoingParticipantSnapshot({
      currentParticipants,
      historicalParticipants,
      hasExplicitCurrentSnapshot: true,
    }).map((participant) => participant.accountId),
    ['acct_creator', 'acct_remaining'],
  );
  assert.deepEqual(
    cloudGroupOutgoingParticipantSnapshot({
      currentParticipants: [],
      historicalParticipants,
      hasExplicitCurrentSnapshot: false,
    }).map((participant) => participant.accountId),
    ['acct_creator', 'acct_remaining', 'acct_removed'],
  );
});

test('Cloud participant snapshots do not silently promote the local sender', () => {
  const participants = cloudGroupParticipantsForCollaborationSession({
    accountId: 'acct_self',
    displayName: 'Self',
    primaryEmail: 'self@example.com',
    avatarUrl: null,
    nodeId: 'acct_self',
    passwordSet: true,
  }, [{
    identityId: 'human:acct_self',
    displayName: 'Self',
    role: 'person',
    humanId: 'acct_self',
  }, {
    identityId: 'human:acct_admin',
    displayName: 'Admin',
    role: 'admin',
    humanId: 'acct_admin',
  }]);

  assert.equal(participants.find((participant) => participant.accountId === 'acct_self')?.role, 'person');
  assert.equal(participants.find((participant) => participant.accountId === 'acct_admin')?.role, 'admin');
});

test('Cloud participant snapshots preserve explicit agent membership by owner', () => {
  const participants = cloudGroupParticipantsForCollaborationSession({
    accountId: 'acct_self',
    displayName: 'Self',
    primaryEmail: 'self@example.com',
    avatarUrl: null,
    nodeId: 'acct_self',
    passwordSet: true,
  }, [{
    identityId: 'human:acct_peer',
    displayName: 'Peer',
    kind: 'human',
    humanId: 'acct_peer',
  }, {
    identityId: 'agent:peer-one',
    displayName: "Peer's Planner",
    kind: 'agent',
    humanId: 'acct_peer',
    agentId: 'cloud_agent_peer_one',
  }, {
    identityId: 'agent:peer-two',
    displayName: "Peer's Reviewer",
    kind: 'agent',
    humanId: 'acct_peer',
    agentId: 'cloud_agent_peer_two',
  }]);

  assert.deepEqual(
    participants.find((participant) => participant.accountId === 'acct_peer')?.agentIds,
    ['cloud_agent_peer_one', 'cloud_agent_peer_two'],
  );
  const parsed = parseCloudGroupControl(encodeCloudGroupControl({
    kind: 'group-update',
    groupId: 'session:group:agents',
    groupTitle: 'Agents',
    createdByAccountId: 'acct_self',
    actor: participants.find((participant) => participant.accountId === 'acct_self')!,
    participants,
  }));
  assert.deepEqual(
    parsed?.participants.find((participant) => participant.accountId === 'acct_peer')?.agentIds,
    ['cloud_agent_peer_one', 'cloud_agent_peer_two'],
  );
});

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
      agentMentionDepth: 1,
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
  assert.equal(parsed?.message?.agentMentionDepth, 1);
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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { cloudFallbackRunClaimsForMessages } from '../src/features/cloud/cloudAgentFallbackClaims';
import {
  cloudGroupMessageTargetsLocalAgent,
  cloudGroupNativeContextMessages,
} from '../src/features/cloud/cloudGroupAgentPolicy';
import {
  cloudGroupAgentHandoffForResponse,
  cloudGroupAgentHandoffTargetsAccount,
  cloudGroupMentionCatalog,
  cloudGroupMentionInstruction,
  resolveCloudGroupAgentMention,
} from '../src/features/cloud/cloudGroupMentions';
import {
  encodeCloudGroupControl,
  type CloudGroupParticipant,
} from '../src/features/cloud/cloudGroupMessages';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';

const participants: CloudGroupParticipant[] = [
  { accountId: 'acct_source', displayName: 'Alex Morgan', avatarUrl: null, role: 'admin' },
  { accountId: 'acct_target', displayName: "D'Arcy Lin", avatarUrl: null, role: 'person' },
  { accountId: 'acct_unicode', displayName: '陈 美', avatarUrl: null, role: 'person' },
];

const sourceAccount: CloudAccount = {
  accountId: 'acct_source',
  displayName: 'Alex Morgan',
  primaryEmail: 'source@example.com',
  avatarUrl: null,
  nodeId: 'node_source',
  passwordSet: true,
};

test('group catalog exposes exact person and participant-Kordi handles', () => {
  const catalog = cloudGroupMentionCatalog(participants);
  assert.ok(catalog.some((entry) => (
    entry.accountId === 'acct_target'
    && entry.targetKind === 'person'
    && entry.handle === 'DArcyLin'
  )));
  assert.ok(catalog.some((entry) => (
    entry.accountId === 'acct_target'
    && entry.targetKind === 'agent'
    && entry.handle === 'DArcyLinsKordi'
  )));
  assert.ok(catalog.some((entry) => (
    entry.accountId === 'acct_unicode'
    && entry.targetKind === 'agent'
    && entry.handle === '陈美sKordi'
  )));

  const instruction = cloudGroupMentionInstruction({
    participants,
    respondingAccountId: 'acct_target',
    requesterAccountId: 'acct_source',
    requesterKind: 'human',
    allowAgentMentions: true,
  });
  assert.match(instruction ?? '', /"my Kordi" means @AlexMorgansKordi/);
  assert.match(instruction ?? '', /@陈美sKordi/);
  assert.doesNotMatch(instruction ?? '', /@DArcyLinsKordi/);
});

test('group Kordi resolution fails closed for ambiguity, invention, and self', () => {
  const ambiguousParticipants: CloudGroupParticipant[] = [
    { accountId: 'acct_one', displayName: 'Same Name', avatarUrl: null, role: 'person' },
    { accountId: 'acct_two', displayName: 'Same-Name', avatarUrl: null, role: 'person' },
  ];
  assert.deepEqual(cloudGroupMentionCatalog(ambiguousParticipants), []);
  assert.equal(resolveCloudGroupAgentMention({
    text: '@SameNamesKordi hello',
    participants: ambiguousParticipants,
    respondingAccountId: 'acct_source',
  }), null);
  assert.equal(resolveCloudGroupAgentMention({
    text: '@AlexMorgansKordi self',
    participants,
    respondingAccountId: 'acct_source',
  }), null);
  assert.equal(resolveCloudGroupAgentMention({
    text: '@InventedKordi hello',
    participants,
    respondingAccountId: 'acct_source',
  }), null);
});

test('agent final text resolves one exact Kordi handoff and never a second hop', () => {
  const requestMessage = {
    id: 'msg_request',
    senderAccountId: 'acct_source',
    text: '@AlexMorgansKordi ask the target',
    createdAtMs: 1,
    senderKind: 'human' as const,
  };
  assert.deepEqual(cloudGroupAgentHandoffForResponse({
    responseText: '@DArcyLinsKordi please provide the status',
    participants,
    respondingAccountId: 'acct_source',
    requestMessage,
  }), {
    targetCloudAgentOwnerAccountId: 'acct_target',
    targetCloudAgentOwnerName: "D'Arcy Lin",
    agentMentionDepth: 1,
  });
  assert.equal(cloudGroupAgentHandoffForResponse({
    responseText: '@DArcyLinsKordi ask again',
    participants,
    respondingAccountId: 'acct_source',
    requestMessage: { ...requestMessage, senderKind: 'agent', agentMentionDepth: 1 },
  }), null);
  assert.equal(cloudGroupAgentHandoffForResponse({
    responseText: '@DArcyLin what do you think?',
    participants,
    respondingAccountId: 'acct_source',
    requestMessage,
  }), null);
});

test('agent-authored handoffs require exact owner metadata and one-hop depth', () => {
  const handoffMessage = {
    id: 'msg_agent_handoff',
    senderAccountId: 'acct_source',
    text: '@DArcyLinsKordi prepare the budget',
    createdAtMs: 2,
    senderKind: 'agent' as const,
    targetCloudAgentOwnerAccountId: 'acct_target',
    targetCloudAgentOwnerName: "D'Arcy Lin",
    agentMentionDepth: 1,
  };
  const targetAccount = {
    ...sourceAccount,
    accountId: 'acct_target',
    displayName: "D'Arcy Lin",
  };
  assert.equal(cloudGroupAgentHandoffTargetsAccount({
    participants,
    message: handoffMessage,
  }, 'acct_target'), true);
  assert.equal(cloudGroupMessageTargetsLocalAgent(
    handoffMessage,
    targetAccount,
    participants,
  ), true);

  const invalidMessages = [
    { ...handoffMessage, targetCloudAgentOwnerAccountId: 'acct_unicode' },
    { ...handoffMessage, targetCloudAgentOwnerAccountId: undefined },
    { ...handoffMessage, agentMentionDepth: 2 },
    { ...handoffMessage, targetCloudAgentId: 'cloud_agent_forged' },
    { ...handoffMessage, text: '@InventedKordi prepare the budget' },
  ];
  for (const invalid of invalidMessages) {
    assert.equal(cloudGroupMessageTargetsLocalAgent(
      invalid,
      targetAccount,
      participants,
    ), false);
  }
});

test('agent-authored handoffs produce only the resolved owner Cloud fallback claim', () => {
  const groupId = 'session:group:agent-handoff';
  const handoffMessage = {
    id: 'msg_agent_handoff',
    senderAccountId: 'acct_source',
    text: '@DArcyLinsKordi prepare the budget',
    createdAtMs: 2,
    senderKind: 'agent' as const,
    senderDisplayName: "Alex Morgan's Kordi",
    targetCloudAgentOwnerAccountId: 'acct_target',
    targetCloudAgentOwnerName: "D'Arcy Lin",
    agentMentionDepth: 1,
  };
  const body = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_source',
    actor: participants[0],
    participants,
    message: handoffMessage,
  });
  const outgoing: CloudMessage = {
    messageId: 'wire_agent_handoff',
    fromAccountId: 'acct_source',
    toAccountId: 'acct_target',
    body,
    createdAt: '2026-08-06T00:00:00Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: groupId,
  };
  const targetContact = cloudContactToContact({
    accountId: 'acct_target',
    displayName: "D'Arcy Lin",
    avatarUrl: null,
    nodeId: 'node_target',
    createdAt: '2026-08-06T00:00:00Z',
  });
  const claims = cloudFallbackRunClaimsForMessages({
    account: sourceAccount,
    contacts: [targetContact],
    messagesByPeer: { acct_target: [outgoing] },
  });
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.ownerAccountId, 'acct_target');
  assert.equal(claims[0]?.requestMessageId, handoffMessage.id);

  const forgedBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_source',
    actor: participants[0],
    participants,
    message: { ...handoffMessage, targetCloudAgentOwnerAccountId: 'acct_unicode' },
  });
  assert.deepEqual(cloudFallbackRunClaimsForMessages({
    account: sourceAccount,
    contacts: [targetContact],
    messagesByPeer: { acct_target: [{ ...outgoing, body: forgedBody }] },
  }), []);
});

test('local group context maps the requester and disables second-hop agents', () => {
  const groupId = 'session:group:mention-context';
  const requestId = 'msg_human_request';
  const requestBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_source',
    actor: participants[0],
    participants,
    message: {
      id: requestId,
      senderAccountId: 'acct_source',
      text: '@DArcyLinsKordi ask my Kordi',
      createdAtMs: 2,
      senderKind: 'human',
    },
  });
  const cloudMessage: CloudMessage = {
    messageId: 'wire_human_request',
    fromAccountId: 'acct_source',
    toAccountId: 'acct_target',
    body: requestBody,
    createdAt: '2026-08-06T00:00:00Z',
    deliveredAt: null,
    readAt: null,
    direction: 'outgoing',
    sessionId: groupId,
  };
  const index = buildCloudMessageIndex('acct_source', {
    acct_target: [cloudMessage],
  });
  const context = cloudGroupNativeContextMessages({
    groupRows: index.groupRows,
    groupId,
    requestMessageId: requestId,
    requestCreatedAtMs: 2,
    respondingAccountId: 'acct_target',
  });
  assert.match(context.at(-1)?.text ?? '', /Group @mention permissions/);
  assert.match(context.at(-1)?.text ?? '', /"my Kordi" means @AlexMorgansKordi/);
  assert.doesNotMatch(context.at(-1)?.text ?? '', /@DArcyLinsKordi/);

  const secondHopBody = encodeCloudGroupControl({
    kind: 'group-message',
    groupId,
    groupSpaceId: groupId,
    groupTitle: null,
    createdByAccountId: 'acct_source',
    actor: participants[0],
    participants,
    message: {
      id: 'msg_agent_request',
      senderAccountId: 'acct_source',
      text: '@DArcyLinsKordi ask again',
      createdAtMs: 3,
      senderKind: 'agent',
      targetCloudAgentOwnerAccountId: 'acct_target',
      agentMentionDepth: 1,
    },
  });
  const secondHopIndex = buildCloudMessageIndex('acct_source', {
    acct_target: [{ ...cloudMessage, messageId: 'wire_agent_request', body: secondHopBody }],
  });
  const secondHopContext = cloudGroupNativeContextMessages({
    groupRows: secondHopIndex.groupRows,
    groupId,
    requestMessageId: 'msg_agent_request',
    requestCreatedAtMs: 3,
    respondingAccountId: 'acct_target',
  });
  assert.match(secondHopContext.at(-1)?.text ?? '', /do not ask another agent/);
  assert.doesNotMatch(secondHopContext.at(-1)?.text ?? '', /Agents:/);
});

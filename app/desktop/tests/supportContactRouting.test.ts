import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeConversationForSelection,
  applyCanonicalHydrationPlaceholder,
  pendingCloudCollaborationConversationForActiveId,
} from '../src/app/viewModels/conversationSelection';
import { resolveCanonicalPageSessionId } from '../src/app/useKordiCanonicalSessionStore';
import {
  resolveDirectHostedAgentTarget,
  resolveLockedKordiSupportCloudConversationId,
  resolveLockedKordiSupportAgentTarget,
} from '../src/features/chat/messageActions/directHostedAgentTarget';
import { shouldUseCollaborationConversationRouting } from '../src/features/chat/messageActions/chatMessages';
import type { Conversation } from '../src/kordi-app/types';
import { KORDI_SUPPORT_AVATAR_URL } from '../src/features/support/supportIdentity';

function supportConversation(): Conversation {
  return {
    id: 'cloud:conversation:acct_kordi_support:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support',
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    name: 'Kordi Support',
    type: 'person',
    subtitle: 'Ask questions or suggest improvements',
    unread: 0,
    collaborationSources: ['Cloud'],
    trust: 'Cloud',
    directness: 'Person chat',
    participants: ['Me', 'Kordi Support'],
    messages: [],
    supportTicketEnabled: true,
    collaborationTarget: {
      hostId: 'cloud',
      nodeId: 'acct_kordi_support',
      displayName: 'Kordi Support',
      ownerName: 'Kordi',
      runtime: 'kordi-desktop',
      humanId: 'acct_kordi_support',
      agentId: 'cloud_agent_kordi_support',
    },
  };
}

function supportConversationWithRealOwner(): Conversation {
  const conversation = supportConversation();
  return {
    ...conversation,
    id: 'cloud:conversation:acct_real_support_owner:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support',
    collaborationTarget: {
      ...conversation.collaborationTarget!,
      nodeId: 'acct_real_support_owner',
      humanId: 'acct_real_support_owner',
    },
  };
}

test('legacy unscoped support selection resolves to the named support session', () => {
  const conversation = supportConversation();
  const selected = activeConversationForSelection(
    'cloud:conversation:acct_kordi_support:agent',
    [conversation],
    { isNativeShell: true, nativeChatPlaceholder: conversation },
  );

  assert.equal(selected.id, conversation.id);
  assert.equal(selected.name, 'Kordi Support');
});

test('legacy support selection follows the locked agent when the server uses a real owner account', () => {
  const conversation = supportConversationWithRealOwner();
  const selected = activeConversationForSelection(
    'cloud:conversation:acct_kordi_support:agent',
    [conversation],
    { isNativeShell: true, nativeChatPlaceholder: conversation },
  );

  assert.equal(selected.id, conversation.id);
  assert.equal(selected.collaborationTarget?.nodeId, 'acct_real_support_owner');
  assert.equal(selected.collaborationTarget?.agentId, 'cloud_agent_kordi_support');
});

test('a new scoped Support selection reuses a legacy message-backed Support thread', () => {
  const existingConversation = {
    ...supportConversationWithRealOwner(),
    canonicalSessionId: 'session:direct-agent:acct_me:cloud_agent_kordi_support',
    messages: [{
      id: 'support-history',
      role: 'person' as const,
      sender: 'Kordi Support',
      senderType: 'human' as const,
      text: 'How can I help?',
      time: '20:40',
    }],
  };
  const activeScopedId = 'cloud:conversation:acct_real_support_owner:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support';
  const selected = activeConversationForSelection(
    activeScopedId,
    [existingConversation],
    { isNativeShell: true, nativeChatPlaceholder: existingConversation },
  );

  assert.equal(selected.id, existingConversation.id);
  assert.equal(selected.messages.length, 1);
});

test('runtime-only support conversation does not show a permanent canonical loader', () => {
  const conversation = supportConversation();
  const selected = applyCanonicalHydrationPlaceholder(conversation, 'cold');

  assert.equal(selected, conversation);
  assert.deepEqual(selected.messages, []);
});

test('legacy support selection resolves canonical hydration through the scoped conversation', () => {
  const conversation = supportConversationWithRealOwner();
  const canonicalSessionId = conversation.canonicalSessionId ?? '';
  const resolved = resolveCanonicalPageSessionId(
    'cloud:conversation:acct_kordi_support:agent',
    new Set([canonicalSessionId]),
    [{
      id: conversation.id,
      canonicalSessionId,
      hostId: 'cloud',
      peerNodeId: 'acct_real_support_owner',
      peerDisplayName: 'Kordi Support',
      peerOwnerName: 'Kordi',
      peerRuntime: 'kordi-desktop',
      projectId: null,
      projectName: null,
      title: 'Kordi Support',
      subtitle: '',
      unreadCount: 0,
      updatedAtMs: 1,
      updatedAtLabel: 'now',
      awaitingReply: false,
      peerTyping: false,
      peerLastHeartbeatLabel: null,
      outreach: null,
      identity: {
        sourceHostId: 'cloud',
        localHumanId: 'acct_me',
        localHumanName: 'Me',
        localAgentId: 'cloud-local-agent',
        localAgentName: 'My Kordi',
        localAgentNodeId: 'acct_me',
        remoteHumanId: 'acct_real_support_owner',
        remoteHumanName: 'Kordi',
        remoteHumanNodeId: 'acct_real_support_owner',
        remoteAgentId: 'cloud_agent_kordi_support',
        remoteAgentName: 'Kordi Support',
        remoteAgentNodeId: 'acct_real_support_owner',
        remoteAgentRuntime: 'kordi-desktop',
      },
      messages: [],
      supportTicketEnabled: true,
    }],
  );

  assert.equal(resolved, canonicalSessionId);
});

test('scoped Cloud route resolves its embedded canonical session before the conversation read model loads', () => {
  const canonicalSessionId = 'session:self-agent:cloud-session';
  const resolved = resolveCanonicalPageSessionId(
    'cloud:conversation:acct_me:agent:session:session%3Aself-agent%3Acloud-session',
    new Set([canonicalSessionId]),
    [],
  );

  assert.equal(resolved, canonicalSessionId);
});

test('legacy pending support selection preserves its product identity and direct route', () => {
  const conversation = pendingCloudCollaborationConversationForActiveId(
    'cloud:conversation:acct_kordi_support:agent',
  );

  assert.equal(conversation?.name, 'Kordi Support');
  assert.equal(conversation?.subtitle, 'Ask questions or suggest improvements');
  assert.equal(conversation?.type, 'person');
  assert.equal(conversation?.directness, 'Person chat');
  assert.equal(conversation?.supportTicketEnabled, true);
  assert.equal(conversation?.profileImageUrl, KORDI_SUPPORT_AVATAR_URL);
  assert.equal(conversation?.collaborationTarget?.runtime, 'kordi-desktop');
  assert.equal(conversation?.collaborationTarget?.agentId, 'cloud_agent_kordi_support');
  assert.deepEqual(conversation?.messages, []);
  assert.deepEqual(resolveDirectHostedAgentTarget({
    mentionedAgentId: null,
    mentionedTarget: null,
    activeTarget: conversation?.collaborationTarget,
  }), {
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_kordi_support',
    targetCloudAgentOwnerName: 'Kordi',
  });
});

test('scoped pending support selection recovers the support target from its session id', () => {
  const conversation = pendingCloudCollaborationConversationForActiveId(
    'cloud:conversation:acct_support_owner:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support',
  );

  assert.equal(conversation?.name, 'Kordi Support');
  assert.equal(conversation?.supportTicketEnabled, true);
  assert.equal(conversation?.collaborationTarget?.nodeId, 'acct_support_owner');
  assert.equal(conversation?.collaborationTarget?.agentId, 'cloud_agent_kordi_support');
});

test('locked support routing survives a partially hydrated person-style target', () => {
  const lockedTarget = resolveLockedKordiSupportAgentTarget({
    conversationId: 'cloud:conversation:acct_real_support_owner:agent',
    resolvedConversationId: 'cloud:conversation:acct_real_support_owner:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support',
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    supportTicketEnabled: true,
    activeTarget: {
      hostId: 'cloud',
      nodeId: 'acct_real_support_owner',
      humanId: 'acct_real_support_owner',
      displayName: 'Kordi Support',
      ownerName: 'Kordi',
      runtime: 'person',
      agentId: null,
    },
  });

  assert.deepEqual(lockedTarget, {
    agentId: 'cloud_agent_kordi_support',
    name: 'Kordi Support',
    ownerAccountId: 'acct_real_support_owner',
    ownerName: 'Kordi',
  });
  assert.deepEqual(resolveDirectHostedAgentTarget({
    mentionedAgentId: null,
    mentionedTarget: null,
    activeTarget: null,
    lockedTarget,
  }), {
    targetCloudAgentId: 'cloud_agent_kordi_support',
    targetCloudAgentName: 'Kordi Support',
    targetCloudAgentOwnerAccountId: 'acct_real_support_owner',
    targetCloudAgentOwnerName: 'Kordi',
  });
  assert.equal(resolveLockedKordiSupportCloudConversationId({
    resolvedConversationId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    lockedTarget,
  }), 'cloud:conversation:acct_real_support_owner:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support');
  assert.equal(shouldUseCollaborationConversationRouting({
    activeConversationUsesCollaboration: false,
    activeConvCollaborationTarget: null,
    forceCollaborationRouting: Boolean(lockedTarget),
  }), true);
});

test('locked support routing prefers the hydrated server owner over a legacy placeholder', () => {
  const lockedTarget = resolveLockedKordiSupportAgentTarget({
    conversationId: 'cloud:conversation:acct_kordi_support:agent',
    resolvedConversationId: 'cloud:conversation:acct_kordi_support:agent',
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    supportTicketEnabled: true,
    activeTarget: {
      hostId: 'cloud',
      nodeId: 'acct_real_support_owner',
      humanId: 'acct_real_support_owner',
      displayName: 'Kordi Support',
      ownerName: 'Kordi',
      runtime: 'person',
      agentId: null,
    },
  });

  assert.equal(lockedTarget?.ownerAccountId, 'acct_real_support_owner');
  assert.equal(resolveLockedKordiSupportCloudConversationId({
    resolvedConversationId: 'cloud:conversation:acct_kordi_support:agent',
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    lockedTarget,
  }), 'cloud:conversation:acct_real_support_owner:agent:session:session%3Adirect-system-agent%3Aacct_me%3Acloud_agent_kordi_support');
});

test('locked support routing skips blank hydrated owner fields', () => {
  const lockedTarget = resolveLockedKordiSupportAgentTarget({
    conversationId: 'cloud:conversation:acct_real_support_owner:agent',
    resolvedConversationId: 'cloud:conversation:acct_real_support_owner:agent',
    canonicalSessionId: 'session:direct-system-agent:acct_me:cloud_agent_kordi_support',
    supportTicketEnabled: true,
    activeTarget: {
      hostId: 'cloud',
      nodeId: 'acct_real_support_owner',
      humanId: '   ',
      displayName: 'Kordi Support',
      ownerName: 'Kordi',
      runtime: 'person',
      agentId: null,
    },
  });

  assert.equal(lockedTarget?.ownerAccountId, 'acct_real_support_owner');
});

test('an ordinary person chat without an agent target stays plain text', () => {
  assert.equal(resolveDirectHostedAgentTarget({
    mentionedAgentId: null,
    mentionedTarget: null,
    activeTarget: {
      hostId: 'cloud',
      nodeId: 'acct_contact',
      humanId: 'acct_contact',
      displayName: 'Contact',
      ownerName: 'Contact',
      runtime: 'person',
      agentId: null,
    },
  }), null);
});

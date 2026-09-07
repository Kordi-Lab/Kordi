import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatMessageActions } from '../src/features/chat/messageActions/chatMessages';
import type { UseChatMessageActionsArgs } from '../src/features/chat/messageActions/types';
import { useCloudDirectAgentExecution } from '../src/features/cloud/useCloudDirectAgentExecution';
import { applyCloudGroupAgentControl, type ApplyCloudGroupAgentControlInput } from '../src/features/cloud/cloudGroupAgentControl';
import { buildCloudMessageIndex } from '../src/features/cloud/cloudMessageIndex';
import { cloudFallbackRunClaimsForMessages } from '../src/features/cloud/cloudAgentFallbackClaims';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import type { CloudAccount, CloudAuthClient, CloudMessage } from '../src/features/cloud/authClient';
import type { DesktopChatTurnSnapshot, DesktopCollaborationState } from '../src/kordi-app/types';
import { cloudContactToContact } from '../src/features/cloud/useCloudContacts';
import { __setSessionBackendForTests } from '../src/features/cloud/session';
import { cloudAccountAvatarFixture as avatar } from './helpers/cloudAccountAvatarFixture';

const noop = () => {};
const owner: CloudAccount = { accountId: 'owner', displayName: 'Owner', primaryEmail: 'owner@example.test', avatarUrl: null, avatar, nodeId: 'owner', passwordSet: true };
const peer: CloudAccount = { ...owner, accountId: 'peer', displayName: 'Peer', nodeId: 'peer' };

async function withDom(run: (root: ReturnType<typeof createRoot>) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const values = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(document.getElementById('root')!);
  try { await run(root); }
  finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

function request(sender: CloudAccount): CloudMessage {
  return { messageId: `request-${sender.accountId}`, fromAccountId: sender.accountId,
    toAccountId: sender.accountId === owner.accountId ? peer.accountId : owner.accountId,
    sessionId: 'session:direct-person:owner:peer', createdAt: new Date().toISOString(),
    deliveredAt: null, readAt: null, direction: sender.accountId === owner.accountId ? 'outgoing' : 'incoming',
    body: encodeCloudDirectMessageEnvelope({ schemaVersion: 1, kind: 'message', text: '@OwnerKordi hi',
      targetCloudAgentId: 'cloud-agent:owner', targetCloudAgentName: 'Owner Assistant', targetCloudAgentOwnerAccountId: 'owner' }),
  };
}

test('an unauthenticated owner opens provider settings before publishing a mention; peer requests remain sendable', async () => {
  await withDom(async root => {
    for (const [hasAuth, targetOwner, savedAuth, inThread] of [
      [false, 'owner', false, false], [false, 'peer', false, false], [true, 'owner', true, false],
      [false, 'owner', true, false], [false, 'owner', false, true],
    ] as const) {
      let loginRequests = 0;
      let sent = 0;
      let draftClears = 0;
      const text = `@${targetOwner}Agent hi`;
      const host = { id: 'cloud', humanId: 'owner', nodeId: 'owner', ownerName: 'Owner',
        activeAgentId: 'cloud-agent:owner', agents: [{ id: 'cloud-agent:owner', label: 'Owner Assistant', isDefault: true }],
        visiblePeers: [], projects: [] };
      const state = { activeHostId: 'cloud', hosts: [host], conversations: [] } as unknown as DesktopCollaborationState;
      const args = {
        activeConvId: 'cloud:conversation:peer:person', activeConvCanonicalSessionId: 'session:direct-person:owner:peer',
        activeConversationUsesCollaboration: true, activeConvMessages: [], chatConversations: [],
        activeConvCollaborationTarget: { hostId: 'cloud', nodeId: 'peer', humanId: 'peer', runtime: 'person' },
        activeConvMentionScope: { id: 'cloud:conversation:peer:person', canonicalSessionId: 'session:direct-person:owner:peer' },
        isNativeShell: true, hasAnyDesktopAuth: hasAuth, hasLocalProviderAuth: savedAuth, desktopChatState: null, canonicalSessionState: null,
        desktopCollaborationState: state, desktopLiveTurn: null, queuedDesktopMessagesBySession: {},
        composerDrafts: { chat: text, project: '' }, composerSelections: { chat: { model: 'test', thinking: 'default', mode: 'agent' } }, chatComposerAttachments: [],
        selectedChatAgentMentionRef: { current: { targetKind: 'agent', value: `${targetOwner}Agent`, label: `${targetOwner} Assistant`,
          sourceHostId: 'cloud', nodeId: targetOwner, humanId: targetOwner, agentId: `cloud-agent:${targetOwner}`, runtime: 'kordi-desktop' } },
        collaborationSendInFlightConversationIdsRef: { current: new Set() }, localChatSendInFlightRef: { current: null },
        shouldAutoFollowChatRef: { current: false }, attachmentSummaryText: (value: string) => value,
        resolveChatRuntimeRoute: () => null, openAgentAuthentication: () => { loginRequests++; },
        handleLocalSlashCommand: async () => assert.fail('The auth dialog must not navigate away and lose the draft'),
        sendCloudCollaborationMessage: async () => { sent++; return request(owner); },
        setComposerDrafts: () => { draftClears++; },
        setActiveConvId: noop, setCanonicalSessionState: noop, setChatComposerAttachments: noop,
        setCloudCollaborationState: noop, setDesktopChatError: noop, setDesktopChatState: noop,
        setDesktopLiveTurnsBySession: noop, setIsDesktopChatSending: noop, setOpenComposerSelector: noop,
        setPendingUserChatMessage: noop, setQueuedDesktopMessagesBySession: noop,
      } as unknown as UseChatMessageActionsArgs;
      let actions: ReturnType<typeof useChatMessageActions> | undefined;
      function Harness() { actions = useChatMessageActions(args); return null; }
      await act(async () => root.render(<Harness key={`${hasAuth}-${targetOwner}-${savedAuth}-${inThread}`} />));
      const blocked = !savedAuth && targetOwner === 'owner';
      await act(async () => {
        if (inThread) await assert.rejects(actions!.handleSendChatMessage(undefined, undefined, [], [], {
          action: 'thread', source: { sourceSessionId: 'session:direct-person:owner:peer', sourceMessageId: 'root', senderLabel: 'Owner', textPreview: 'Root', attachmentCount: 0 },
        }), /No provider configured/);
        else await actions!.handleSendChatMessage();
      });
      assert.equal(loginRequests, blocked ? 1 : 0);
      assert.equal(sent, blocked ? 0 : 1);
      assert.equal(draftClears, blocked ? 0 : 1);
    }
  });
});

test('an unready owner Mac neither claims nor fails a peer request, leaving it available to Cloud', async () => {
  await withDom(async root => {
    for (const sender of [owner, peer]) {
      const message = request(sender);
      let turns: Record<string, DesktopChatTurnSnapshot> = {};
      const processed = new Set<string>();
      const index = buildCloudMessageIndex(owner.accountId, { peer: [message] });
      const args: Parameters<typeof useCloudDirectAgentExecution>[0] = {
        account: owner, client: {} as CloudAuthClient, cloudAgentDefinitionsById: {}, cloudLookupContacts: [], cloudMessageIndex: index,
        initialMessagesSettled: true, runtimeReady: false, processedRequestIdsRef: { current: processed }, turnIdsByRequestIdRef: { current: new Map() },
        activityRef: { current: { tasksBySessionId: {}, artifactsBySessionId: {} } },
        setLocalTurns: update => { turns = typeof update === 'function' ? update(turns) : update; },
        setActivity: noop, mergeMessage: noop, syncMessages: async () => {}, reportWarning: () => assert.fail('No execution should be attempted'),
      };
      function Harness() { useCloudDirectAgentExecution(args); return null; }
      await act(async () => root.render(<Harness key={sender.accountId} />));
      assert.equal(processed.size, 0);
      assert.deepEqual(turns, {});
      if (sender === peer) {
        const claims = cloudFallbackRunClaimsForMessages({ account: peer,
          contacts: [cloudContactToContact({ ...owner, createdAt: message.createdAt })], messagesByPeer: { owner: [message] } });
        assert.equal(claims.length, 1);
        assert.equal(claims[0].ownerAccountId, owner.accountId);
        assert.equal(claims[0].requesterAccountId, peer.accountId);
      }
    }
  });
});

test('unready group executors leave admission to Cloud without consuming the request', () => {
  const processed = new Set<string>();
  applyCloudGroupAgentControl({
    context: { envelope: {} }, runtime: { ready: false, processedMentionIds: processed },
  } as unknown as ApplyCloudGroupAgentControlInput);
  assert.equal(processed.size, 0);
});

test('owner admission failures become terminal UI state instead of an endless processing bubble', async () => {
  __setSessionBackendForTests({ load: async () => ({ accountId: 'owner', token: 'fixture-token', expiresAt: '2099-01-01' }), save: async () => {}, clear: async () => {} });
  try {
    await withDom(async root => {
      for (const failAt of ['claim', 'admit']) {
        const message = request(owner);
        let turns: Record<string, DesktopChatTurnSnapshot> = {};
        const client = { desktopAgentExecution: async (_token: string, action: string) => {
          if (action === 'claim' && failAt === 'admit') return { runId: 'fixture-run', acquired: true, turnIdentity: { ownerAccountId: 'owner', requesterAccountId: 'owner' } };
          throw new Error('Execution admission failed');
        } } as unknown as CloudAuthClient;
        const args: Parameters<typeof useCloudDirectAgentExecution>[0] = {
          account: owner, client, cloudAgentDefinitionsById: {}, cloudLookupContacts: [],
          cloudMessageIndex: buildCloudMessageIndex(owner.accountId, { peer: [message] }),
          initialMessagesSettled: true, runtimeReady: true, processedRequestIdsRef: { current: new Set() }, turnIdsByRequestIdRef: { current: new Map() },
          activityRef: { current: { tasksBySessionId: {}, artifactsBySessionId: {} } },
          setLocalTurns: update => { turns = typeof update === 'function' ? update(turns) : update; },
          setActivity: noop, mergeMessage: noop, syncMessages: async () => {}, reportWarning: noop,
        };
        function Harness() { useCloudDirectAgentExecution(args); return null; }
        await act(async () => { root.render(<Harness key={failAt} />); });
        assert.equal(turns[message.messageId]?.status, 'failed');
        assert.equal(turns[message.messageId]?.completed, true);
        assert.equal(turns[message.messageId]?.error, 'Execution admission failed');
      }
    });
  } finally { __setSessionBackendForTests(null); }
});

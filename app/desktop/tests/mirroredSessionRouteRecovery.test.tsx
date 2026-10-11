import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act, useState } from 'react';

import { useCloudAgentRuntimeRouteSync } from '../src/app/useCloudAgentRuntimeRouteSync';
import { shouldUseNoProviderSelfAgentShortcut } from '../src/features/chat/messageActions/localAgentSessionTarget';
import type { ComposerSelectionState } from '../src/features/chat/composerController.types';
import type { CloudMessage } from '../src/features/cloud/authClient';
import {
  applySynchronizedCloudAgentRuntimeRoutes,
  cloudAgentRuntimeSessionId,
  encodeCloudAgentRuntimeRouteChange,
} from '../src/features/cloud/cloudAgentRuntime';
import { mirroredSessionRequestRouteRecords } from '../src/features/cloud/cloudAgentRuntimeRequestRoutes';
import { routeRunsOnKordiCloud } from '../src/features/cloud/cloudAgentRuntimeRoute';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';
import type { DesktopChatMessageRoute } from '../src/lib/desktop';
import type { CanonicalSessionRequestRoute } from '../src/lib/desktopCanonicalSessionRoutes';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const ACCOUNT = 'acct_me';
const SESSION = 'session:self-agent:panel';
const runtimeSessionId = cloudAgentRuntimeSessionId(ACCOUNT, SESSION) ?? '';
const hostedRoute: DesktopChatMessageRoute = {
  model: 'openai/gpt-5.6-sol', authProvider: 'openai', authChoice: 'cloud-login:hosted', thinking: 'medium',
};
const localRoute: DesktopChatMessageRoute = {
  model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic', authChoice: 'local-active-oauth', thinking: 'max',
};

function mirrorRow(sequenceNum: number, route: unknown = hostedRoute, sessionId = SESSION): CanonicalSessionRequestRoute {
  return { sessionId, route, sequenceNum, updatedAtMs: sequenceNum };
}

// The bootstrap carries only the latest message: here a failed request without a route.
const bootstrapLatest: CloudMessage = {
  messageId: 'failed', fromAccountId: ACCOUNT, toAccountId: ACCOUNT, body: 'Try again',
  createdAt: '2026-10-08T00:00:09.000Z', deliveredAt: null, readAt: null, direction: 'outgoing',
  sessionId: SESSION, conversationSequence: 9, messageKind: null,
};

function canonicalMessage(overrides: Partial<CanonicalSessionMessage>): CanonicalSessionMessage {
  return {
    id: 'message', sessionId: SESSION, senderIdentityId: 'human:me', senderRole: 'user',
    messageKind: 'text', contentText: 'Hello', status: 'sent', content: null,
    sequenceNum: 1, createdAtMs: 1, updatedAtMs: 1, sourceTransport: 'desktop-chat-ui', ...overrides,
  };
}

test('mirror records keep only routed rows that name a model', () => {
  const records = mirroredSessionRequestRouteRecords([
    mirrorRow(4),
    mirrorRow(5, { authChoice: 'cloud-login:hosted' }, 'session:no-model'),
    mirrorRow(6, 'not a route', 'session:invalid'),
    mirrorRow(7, hostedRoute, '  '),
  ]);
  assert.deepEqual(records, [{ sessionId: SESSION, sequenceNum: 4, updatedAtMs: 4, route: hostedRoute }]);
});

test('the mirror restores the hosted route when neither the bootstrap nor loaded pages record it', () => {
  const mirrored = mirroredSessionRequestRouteRecords([mirrorRow(4)]);
  const withoutMirror = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [], [bootstrapLatest]);
  assert.equal(withoutMirror[runtimeSessionId], undefined);
  const restored = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [], [bootstrapLatest], null, mirrored);
  assert.deepEqual(restored[runtimeSessionId], hostedRoute);
});

test('a later model change still wins over the mirrored request route', () => {
  const mirrored = mirroredSessionRequestRouteRecords([mirrorRow(4)]);
  const loadedChange = canonicalMessage({
    id: 'change', senderRole: 'system', messageKind: 'agent-model-change', sourceTransport: null,
    content: { agentRuntimeRoute: localRoute }, sequenceNum: 6, updatedAtMs: 6,
  });
  const fromPage = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [loadedChange], [], null, mirrored);
  assert.deepEqual(fromPage[runtimeSessionId], localRoute);

  const cloudChange: CloudMessage = {
    ...bootstrapLatest, messageId: 'cloud-change', messageKind: 'agent-model-change',
    body: encodeCloudAgentRuntimeRouteChange(localRoute, null, true),
  };
  const fromCloud = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [], [cloudChange], null, mirrored);
  assert.deepEqual(fromCloud[runtimeSessionId], localRoute);

  const earlierChange = { ...loadedChange, sequenceNum: 2, updatedAtMs: 2 };
  const requestLater = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [earlierChange], [], null, mirrored);
  assert.deepEqual(requestLater[runtimeSessionId], hostedRoute, 'a later mirrored request wins over an earlier change');
});

test('a model-only change after a mirrored request keeps the account that request recorded', () => {
  const mirrored = mirroredSessionRequestRouteRecords([mirrorRow(10)]);
  const notice = canonicalMessage({
    id: 'notice', senderRole: 'system', messageKind: 'agent-model-change', sourceTransport: 'desktop-chat',
    contentText: 'Switched model to openai/gpt-5.6-sol', content: { detail: 'Model updated' },
    sequenceNum: 12, updatedAtMs: 12,
  });
  const restored = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [notice], [], null, mirrored);
  assert.equal(restored[runtimeSessionId]?.authChoice, hostedRoute.authChoice);
  assert.ok(routeRunsOnKordiCloud(restored[runtimeSessionId]));
});

type SyncResult = ReturnType<typeof useCloudAgentRuntimeRouteSync>;

async function withRouteSync(
  fetchMirroredRequestRoutes: () => Promise<CanonicalSessionRequestRoute[]>,
  run: (current: () => SyncResult) => Promise<void>,
) {
  await withJsdomRoot(async (mount) => {
    // Hold every animation frame so only the synchronous recovery path can supply routes.
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => undefined;
    let latest: SyncResult | null = null;
    const canonicalState = { sessions: [], participants: [], identities: [], messages: [] } as unknown as CanonicalSessionState;
    function Harness() {
      const [routes, setRoutes] = useState<Record<string, DesktopChatMessageRoute>>({});
      const [composerSelections, setComposerSelections] = useState<ComposerSelectionState>({
        chat: { mode: 'agent', model: 'ollama/llama3', thinking: 'off' },
        project: { mode: 'agent', model: 'ollama/llama3', thinking: 'off' },
      });
      latest = useCloudAgentRuntimeRouteSync({
        accountId: ACCOUNT,
        activeConversationId: SESSION,
        activeLoginProviderId: null,
        canonicalSessionState: canonicalState,
        chatModelOptions: [],
        cloudAgentRuntimeRouteMessages: [bootstrapLatest],
        composerAuthByScope: { optionsByScope: { chat: [] } } as never,
        composerUi: { composerSelections, setComposerSelections } as never,
        defaultCloudAgentRuntimeRoute: null,
        desktopAuthState: null as never,
        isNativeShell: true,
        preferredModelValueForProvider: () => null as never,
        resolveComposerProviderId: () => null as never,
        routesBySessionId: routes,
        sendCloudCollaborationMessage: (async () => null) as never,
        setRoutesBySessionId: setRoutes,
        updateCloudCollaborationSessionTitle: (async () => undefined) as never,
        fetchMirroredRequestRoutes,
      });
      return null;
    }
    await mount(<Harness />);
    await act(async () => { await Promise.resolve(); });
    await run(() => latest!);
  });
}

function noProviderShortcut(resolveChatRuntimeRoute: SyncResult['resolveChatRuntimeRoute']) {
  return shouldUseNoProviderSelfAgentShortcut({
    activeConversationUsesCollaborationRouting: false,
    activeConvCanonicalSessionId: SESSION,
    canonicalSessionState: null,
    hasAnyDesktopAuth: routeRunsOnKordiCloud(resolveChatRuntimeRoute(SESSION)),
  });
}

test('a send right after restart uses the mirrored hosted route instead of the no-provider shortcut', async () => {
  await withRouteSync(async () => [mirrorRow(4)], async (current) => {
    assert.deepEqual(current().resolveChatRuntimeRoute(SESSION), hostedRoute);
    assert.equal(noProviderShortcut(current().resolveChatRuntimeRoute), false);
  });
  await withRouteSync(async () => [], async (current) => {
    assert.equal(current().resolveChatRuntimeRoute(SESSION), null);
    assert.equal(noProviderShortcut(current().resolveChatRuntimeRoute), true, 'without any recorded route the shortcut still applies');
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act, useState } from 'react';

import { useCloudAgentRuntimeRouteSync } from '../src/app/useCloudAgentRuntimeRouteSync';
import type { CloudMessage } from '../src/features/cloud/authClient';
import {
  applySynchronizedCloudAgentRuntimeRoutes,
  cloudAgentRuntimeRouteSourceMessages,
  cloudAgentRuntimeSessionId,
  encodeCloudAgentRuntimeRouteChange,
} from '../src/features/cloud/cloudAgentRuntime';
import {
  encodeCloudDirectMessageEnvelope,
  parseCloudDirectMessageEnvelope,
} from '../src/features/cloud/cloudDirectMessages';
import type { ComposerSelectionState } from '../src/features/chat/composerController.types';
import type { CanonicalSessionMessage, CanonicalSessionState } from '../src/kordi-app/types';
import type { DesktopChatMessageRoute } from '../src/lib/desktop';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const ACCOUNT = 'acct_me';
const PANEL_SESSION = 'session:self-agent:panel';
const hostedRoute: DesktopChatMessageRoute = {
  model: 'openai/gpt-5.6-sol', authProvider: 'openai', authChoice: 'cloud-login:hosted', thinking: 'high',
};
const localRoute: DesktopChatMessageRoute = {
  model: 'anthropic/claude-opus-4-1', authProvider: 'anthropic', authChoice: 'local-active-oauth', thinking: 'max',
};

function cloudMessage(id: string, sequence: number, body: string, overrides: Partial<CloudMessage> = {}): CloudMessage {
  return {
    messageId: id, fromAccountId: ACCOUNT, toAccountId: ACCOUNT, body,
    createdAt: `2026-10-08T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    deliveredAt: null, readAt: null, direction: 'outgoing', sessionId: PANEL_SESSION,
    conversationSequence: sequence, messageKind: null, ...overrides,
  };
}

function hostedRequest(id: string, sequence: number, route = hostedRoute, overrides: Partial<CloudMessage> = {}) {
  return cloudMessage(id, sequence, encodeCloudDirectMessageEnvelope({
    schemaVersion: 1, kind: 'message', text: 'Summarize the thread', agentRuntimeRoute: route,
  }), overrides);
}

function modelChange(id: string, sequence: number, route: DesktopChatMessageRoute) {
  return cloudMessage(id, sequence, encodeCloudAgentRuntimeRouteChange(route, null, true), {
    messageKind: 'agent-model-change',
  });
}

const runtimeSessionId = cloudAgentRuntimeSessionId(ACCOUNT, PANEL_SESSION) ?? '';

test('a restart recovers a session route from its latest routed request when no model change exists', () => {
  const sources = cloudAgentRuntimeRouteSourceMessages([
    hostedRequest('request', 3),
    cloudMessage('plain', 4, 'Thanks'),
    hostedRequest('peer-request', 5, localRoute, { fromAccountId: 'acct_peer' }),
  ], ACCOUNT);
  assert.deepEqual(sources.map((message) => message.messageId), ['request']);
  const restored = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [], sources);
  assert.deepEqual(restored[runtimeSessionId], hostedRoute);
});

test('a later model change wins over an earlier request route, and a later request wins over an earlier change', () => {
  const changedLater = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [], [
    hostedRequest('request', 3),
    modelChange('change', 4, localRoute),
  ]);
  assert.deepEqual(changedLater[runtimeSessionId], localRoute);
  const requestedLater = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [], [
    modelChange('change', 2, localRoute),
    hostedRequest('request', 3),
  ]);
  assert.deepEqual(requestedLater[runtimeSessionId], hostedRoute);
});

test('canonical history from this desktop recovers a hosted request route before Cloud history arrives', () => {
  const message = (overrides: Partial<CanonicalSessionMessage>): CanonicalSessionMessage => ({
    id: 'user-1', sessionId: PANEL_SESSION, senderIdentityId: 'human:me', senderRole: 'user',
    messageKind: 'text', contentText: 'Summarize the thread', status: 'sent',
    content: { agentRuntimeRoute: hostedRoute }, sequenceNum: 4, createdAtMs: 4, updatedAtMs: 4,
    sourceTransport: 'desktop-chat-ui', ...overrides,
  });
  const restored = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [message({})], []);
  assert.deepEqual(restored[runtimeSessionId], hostedRoute);
  const mirrored = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [message({ sourceTransport: 'cloud-group-ui' })], []);
  assert.equal(mirrored[runtimeSessionId], undefined, 'another sender route is never adopted');
  const withLaterChange = applySynchronizedCloudAgentRuntimeRoutes({}, ACCOUNT, [
    message({}),
    message({
      id: 'change', senderRole: 'system', messageKind: 'agent-model-change', sourceTransport: null,
      content: { agentRuntimeRoute: localRoute }, sequenceNum: 5, createdAtMs: 5, updatedAtMs: 5,
    }),
  ], []);
  assert.deepEqual(withLaterChange[runtimeSessionId], localRoute);
});

type SyncResult = ReturnType<typeof useCloudAgentRuntimeRouteSync>;
type SentMessage = { conversationId: string; body: string; options: Record<string, unknown> };

async function withRouteSync(
  options: { cloudMessages?: CloudMessage[]; initialRoutes?: Record<string, DesktopChatMessageRoute> },
  run: (handle: { current: () => SyncResult; selections: () => ComposerSelectionState; sent: SentMessage[] }) => Promise<void>,
) {
  await withJsdomRoot(async (mount) => {
    // Hold every animation frame so only the synchronous recovery path can supply routes.
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => undefined;
    const sent: SentMessage[] = [];
    let latest: SyncResult | null = null;
    let latestSelections: ComposerSelectionState | null = null;
    const canonicalState = { sessions: [], participants: [], identities: [], messages: [] } as unknown as CanonicalSessionState;
    function Harness() {
      const [routes, setRoutes] = useState<Record<string, DesktopChatMessageRoute>>(options.initialRoutes ?? {});
      const [composerSelections, setComposerSelections] = useState<ComposerSelectionState>({
        chat: { mode: 'agent', model: 'ollama/llama3', thinking: 'off' },
        project: { mode: 'agent', model: 'ollama/llama3', thinking: 'off' },
      });
      latestSelections = composerSelections;
      latest = useCloudAgentRuntimeRouteSync({
        accountId: ACCOUNT,
        activeConversationId: PANEL_SESSION,
        activeLoginProviderId: null,
        canonicalSessionState: canonicalState,
        chatModelOptions: [],
        cloudAgentRuntimeRouteMessages: options.cloudMessages ?? [],
        composerAuthByScope: { optionsByScope: { chat: [] } } as never,
        composerUi: { composerSelections, setComposerSelections } as never,
        defaultCloudAgentRuntimeRoute: null,
        desktopAuthState: null as never,
        isNativeShell: true,
        preferredModelValueForProvider: () => null as never,
        resolveComposerProviderId: () => null as never,
        routesBySessionId: routes,
        sendCloudCollaborationMessage: (async (conversationId: string, body: string, _attachments: unknown, sendOptions: Record<string, unknown>) => {
          sent.push({ conversationId, body, options: sendOptions });
          return null;
        }) as never,
        setRoutesBySessionId: setRoutes,
        updateCloudCollaborationSessionTitle: (async () => undefined) as never,
      });
      return null;
    }
    await mount(<Harness />);
    await run({ current: () => latest!, selections: () => latestSelections!, sent });
  });
}

test('an inherited route is recorded once as a silent model change for the real session only', async () => {
  const sourceRuntimeSessionId = cloudAgentRuntimeSessionId(ACCOUNT, 'session:self-agent:main') ?? '';
  await withRouteSync({ initialRoutes: { [sourceRuntimeSessionId]: hostedRoute } }, async ({ current, sent }) => {
    await act(async () => { current().inheritCloudAgentRuntimeRoute('session:self-agent:main', 'draft:local-chat'); });
    assert.equal(sent.length, 0, 'the transient draft id is never recorded');
    await act(async () => { current().inheritCloudAgentRuntimeRoute('session:self-agent:main', PANEL_SESSION); });
    await act(async () => { current().inheritCloudAgentRuntimeRoute('session:self-agent:main', PANEL_SESSION); });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].options.messageKind, 'agent-model-change');
    const envelope = parseCloudDirectMessageEnvelope(sent[0].body);
    assert.equal(envelope?.text, '');
    assert.equal(envelope?.synchronizationOnly, true);
    assert.deepEqual(envelope?.agentRuntimeRoute, hostedRoute);
    assert.deepEqual(current().resolveChatRuntimeRoute(PANEL_SESSION), hostedRoute);
  });
});

test('a send right after restart resolves the hosted route recorded by the session history', async () => {
  const otherRuntimeSessionId = cloudAgentRuntimeSessionId(ACCOUNT, 'session:self-agent:other') ?? '';
  await withRouteSync({
    cloudMessages: [hostedRequest('request', 3)],
    initialRoutes: { [otherRuntimeSessionId]: localRoute },
  }, async ({ current, selections, sent }) => {
    assert.deepEqual(current().resolveChatRuntimeRoute(PANEL_SESSION), hostedRoute);
    assert.equal(selections().chat.model, hostedRoute.model);
    assert.equal(selections().chat.thinking, hostedRoute.thinking);
    await act(async () => { current().inheritCloudAgentRuntimeRoute('session:self-agent:other', PANEL_SESSION); });
    assert.equal(sent.length, 0, 'a session whose history already records a route is not recorded again');
  });
});

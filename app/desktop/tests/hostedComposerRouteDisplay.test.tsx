import assert from 'node:assert/strict';
import { test } from 'node:test';

import React, { act, useState } from 'react';

import { useCloudAgentRuntimeRouteSync } from '../src/app/useCloudAgentRuntimeRouteSync';
import type { ComposerSelectionState } from '../src/features/chat/composerController.types';
import { chatComposerFollowsRuntimeSession } from '../src/features/chat/runtimeComposerSync';
import type { CanonicalSessionState } from '../src/kordi-app/types';
import type { DesktopChatMessageRoute } from '../src/lib/desktop';
import type { CanonicalSessionRequestRoute } from '../src/lib/desktopCanonicalSessionRoutes';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const ACCOUNT = 'acct_me';
const SESSION = '9520f4d5-5a9b-426e-a5f7-60f22a570b99';
// What this Mac's runtime reports for the session between turns.
const RUNTIME_MODEL = 'openai/gpt-5.6-sol';

function codexRoute(model: string): DesktopChatMessageRoute {
  return { model: `openai-codex/${model}`, authProvider: 'openai', authChoice: 'cloud-login:work', thinking: 'medium' };
}

type Observed = { route: DesktopChatMessageRoute | null; composerModel: string };

/** Recovers the session route from the local mirror, then reports the route a send uses and the composer model. */
async function recoverHostedSession(mirrored: DesktopChatMessageRoute): Promise<Observed> {
  let observed: Observed | null = null;
  await withJsdomRoot(async (mount) => {
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => undefined;
    const canonicalState = { sessions: [], participants: [], identities: [], messages: [] } as unknown as CanonicalSessionState;
    const rows: CanonicalSessionRequestRoute[] = [{ sessionId: SESSION, route: mirrored, sequenceNum: 99, updatedAtMs: 99 }];
    function Harness() {
      const [routes, setRoutes] = useState<Record<string, DesktopChatMessageRoute>>({});
      const [composerSelections, setComposerSelections] = useState<ComposerSelectionState>({
        chat: { mode: 'agent', model: RUNTIME_MODEL, thinking: 'medium' },
        project: { mode: 'agent', model: RUNTIME_MODEL, thinking: 'medium' },
      });
      const sync = useCloudAgentRuntimeRouteSync({
        accountId: ACCOUNT,
        activeConversationId: SESSION,
        activeLoginProviderId: null,
        canonicalSessionState: canonicalState,
        chatModelOptions: [],
        cloudAgentRuntimeRouteMessages: [],
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
        fetchMirroredRequestRoutes: async () => rows,
      });
      const route = sync.resolveChatRuntimeRoute(SESSION);
      // The runtime refresh after a turn may replace the composer only when the chat follows the runtime.
      const composerModel = chatComposerFollowsRuntimeSession({
        activeConversationUsesCollaboration: false,
        activeConvId: SESSION,
        desktopActiveSessionId: SESSION,
        activeChatRoute: route,
      }) ? RUNTIME_MODEL : composerSelections.chat.model;
      observed = { route, composerModel };
      return null;
    }
    await mount(<Harness />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  });
  assert.ok(observed);
  return observed;
}

for (const model of ['gpt-5.6-sol', 'gpt-6-sol']) {
  test(`a recovered hosted codex route (${model}) is the model the composer shows`, async () => {
    const { route, composerModel } = await recoverHostedSession(codexRoute(model));
    assert.equal(route?.model, `openai-codex/${model}`);
    assert.equal(route?.authChoice, 'cloud-login:work');
    assert.equal(composerModel, route?.model, 'the composer shows the model a send carries');
  });
}

test('a chat on this Mac still mirrors the runtime session', () => {
  const localRoute: DesktopChatMessageRoute = { model: 'openai/gpt-5.6-sol', authProvider: 'openai', authChoice: 'local-active-oauth' };
  const base = { activeConversationUsesCollaboration: false, activeConvId: SESSION, desktopActiveSessionId: SESSION };
  assert.equal(chatComposerFollowsRuntimeSession({ ...base, activeChatRoute: localRoute }), true);
  assert.equal(chatComposerFollowsRuntimeSession({ ...base, activeChatRoute: null }), true);
  assert.equal(chatComposerFollowsRuntimeSession({ ...base, activeChatRoute: codexRoute('gpt-5.6-sol') }), false);
  assert.equal(chatComposerFollowsRuntimeSession({ ...base, activeConversationUsesCollaboration: true, activeChatRoute: null }), false);
});

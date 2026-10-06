import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { useKordiCanonicalPageHydration, useKordiCanonicalSessionStore } from '../src/app/useKordiCanonicalSessionStore';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import { mapCanonicalMessage } from '../src/features/canonical/readModel/messageMapping';
import { markOptimisticCanonicalMessageSent } from '../src/features/chat/messageActions/canonicalDelivery';
import { appendOptimisticCanonicalMessage, prepareCanonicalUserMessage } from '../src/features/chat/messageActions/optimistic';
import { planCloudSelfAgentSync, type CloudSelfAgentSyncLedger } from '../src/features/cloud/cloudSelfAgentForwardSync';
import type { CanonicalMessagePage, CanonicalSessionCatalog, CanonicalSessionMessage, CanonicalSessionState, Message } from '../src/kordi-app/types';
import { companionHistorySessionId, useCompanionHistorySession } from '../src/pages/useCompanionHistorySession';
import { useKordiShellArgs } from '../src/app/useKordiShellArgs';
import { buildChatsPageProps } from '../src/app/mainContentShellBuilders';
import type { KordiShellCompositionArgs } from '../src/app/kordiShellComposition.types';
import { conversation } from './helpers/workspaceSidebarParticipantSpacesFixtures';
import { installDom } from './helpers/transcriptAttachmentDom';
import { waitForReactCondition } from './helpers/waitForReactCondition';
import {
  MAIN_SESSION_ID, PANEL_FIRST_WIRE_ID, PANEL_LATER_SEND_IDS, PANEL_SESSION_ID, panelSessionMessages, panelSessionState,
} from './helpers/panelSessionFixture';

const firstExchange = panelSessionMessages.filter((message) => !PANEL_LATER_SEND_IDS.includes(message.id));
const route = { model: 'anthropic/claude-opus-4-7', authProvider: 'anthropic', authChoice: 'cloud-login:8f5e129f-0b70-436e-937d-349898934eb7', thinking: 'medium' };
// The forward cutoff predates both sessions; the ledger already holds every
// row of the first exchange and of the main pane (all of them forwarded).
const forwardCutoffMs = 1791260400000;
const ledger: CloudSelfAgentSyncLedger = Object.fromEntries(firstExchange.map((message) => [message.id, {
  cloudMessageId: message.id === 'msg:ui:048befde-1689-4d60-81bb-8cef61496540' ? PANEL_FIRST_WIRE_ID : null,
  syncedAtMs: message.updatedAtMs,
}]));

function catalogFor(rows: CanonicalSessionMessage[]): CanonicalSessionCatalog {
  const { messages: _messages, contextSnapshots: _snapshots, ...catalog } = panelSessionState(rows);
  return {
    ...catalog,
    summaries: [PANEL_SESSION_ID, MAIN_SESSION_ID].map((sessionId) => {
      const sessionRows = rows.filter((message) => message.sessionId === sessionId);
      const latestMessage = [...sessionRows].sort((left, right) => right.sequenceNum - left.sequenceNum || right.createdAtMs - left.createdAtMs)[0] ?? null;
      return { sessionId, messageCount: sessionRows.length, latestMessage, contextSnapshotCount: 0 };
    }),
  };
}

function pageFor(rows: CanonicalSessionMessage[], sessionId: string): CanonicalMessagePage {
  const sessionRows = rows.filter((message) => message.sessionId === sessionId);
  return { sessionId, messages: sessionRows, oldestSequenceNum: 1, newestSequenceNum: sessionRows.length, hasOlder: false };
}

async function sendFromPanel(companionSessionId: string | null) {
  const dom = installDom();
  const persisted = [...firstExchange];
  mockIPC((command, payload) => {
    if (command === 'desktop_canonical_session_catalog') return catalogFor(persisted);
    assert.equal(command, 'desktop_canonical_session_messages');
    return pageFor(persisted, String((payload as Record<string, unknown>).sessionId));
  });
  let canonical!: ReturnType<typeof useKordiCanonicalSessionStore>;
  function Harness() {
    canonical = useKordiCanonicalSessionStore({ accountId: 'acct_3336a8198ce94bfb8af7ffbcf18da047', isNativeShell: true });
    useKordiCanonicalPageHydration({
      activeConversationId: MAIN_SESSION_ID, activeProjectSessionId: '', companionSessionId,
      collaborationState: null, hydrateSessionPage: canonical.hydrateSessionPage, store: canonical.store,
    });
    return null;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Harness)));
    await waitForReactCondition(() => canonical.store.hydrationBySessionId[MAIN_SESSION_ID] === 'ready', 'the main pane page must load');
    if (companionSessionId) {
      await waitForReactCondition(() => canonical.store.hydrationBySessionId[companionSessionId] === 'ready', 'the panel page must load');
    }
    const prepared = prepareCanonicalUserMessage(PANEL_SESSION_ID, 'human:acct_3336a8198ce94bfb8af7ffbcf18da047', 'panel test one: reply with the word pong', [], '22:28', 'desktop-chat-ui');
    assert.ok(prepared);
    // The hosted send path: an optimistic bubble, then the delivered mark that carries the route.
    await act(async () => canonical.setState((current) => appendOptimisticCanonicalMessage(current, prepared)));
    await act(async () => canonical.setState((current) => markOptimisticCanonicalMessageSent(current, PANEL_SESSION_ID, prepared.messageId, { agentRuntimeRoute: route })));
    return { state: canonical.state!, sentId: prepared.messageId };
  } finally {
    await act(async () => root.unmount()); clearMocks(); dom.restore();
  }
}

test('a send from the side panel stays in canonical state and is planned for forwarding', async () => {
  const { state, sentId } = await sendFromPanel(PANEL_SESSION_ID);
  const sent = state.messages.find((message) => message.id === sentId);
  assert.equal(sent?.status, 'sent', 'The panel send must survive the retained page window');
  const operations = planCloudSelfAgentSync(state, ledger, { createdAfterMs: forwardCutoffMs });
  assert.deepEqual(operations.map((operation) => operation.localMessageId), [sentId]);
  assert.equal(operations[0].historyOnly, undefined, 'A new panel send is a live request, not recovered history');
  assert.ok(createCanonicalSessionReadModel(state)!.messages(PANEL_SESSION_ID).some((message) => message.id === sentId));
});

test('a side panel session outside the retained page window keeps only its catalog head', async () => {
  const { state, sentId } = await sendFromPanel(null);
  assert.ok(!state.messages.some((message) => message.id === sentId), 'Documents why the panel session page must be retained');
});

test('the panel session id resolves to the canonical session, never to a subsession or draft', () => {
  assert.equal(companionHistorySessionId({ id: PANEL_SESSION_ID, canonicalSessionId: PANEL_SESSION_ID }), PANEL_SESSION_ID);
  assert.equal(companionHistorySessionId({ id: 'subsession', canonicalSessionId: PANEL_SESSION_ID, agentSubsessionId: 'sub-1' }), null);
  assert.equal(companionHistorySessionId(null), null);
});

test('the open side panel reports its session to the app-level page hydration', async () => {
  const dom = installDom();
  const reported: Array<string | null> = [];
  const onCompanionHistorySessionChange = (sessionId: string | null) => { reported.push(sessionId); };
  function Panel({ open }: { open: boolean }) {
    const shell = useKordiShellArgs({
      workspacePanels: { onCompanionHistorySessionChange },
      environment: { desktopAuthState: null },
    } as unknown as KordiShellCompositionArgs);
    const page = buildChatsPageProps(shell.mainContent);
    assert.equal(page.transcript.onCompanionHistorySessionChange, onCompanionHistorySessionChange);
    useCompanionHistorySession(open ? { id: PANEL_SESSION_ID, canonicalSessionId: PANEL_SESSION_ID } : null, page.transcript.onCompanionHistorySessionChange);
    return null;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Panel, { open: true })));
    await act(async () => root.render(createElement(Panel, { open: false })));
    assert.deepEqual(reported, [PANEL_SESSION_ID, null]);
  } finally {
    await act(async () => root.unmount()); dom.restore();
  }
});

test('the panel transcript shows one request per exchange and every later panel send', () => {
  const state: CanonicalSessionState = panelSessionState();
  const model = createCanonicalSessionReadModel(state)!;
  const identities = new Map(state.identities.map((identity) => [identity.id, identity]));
  const runtime = firstExchange.filter((message) => message.sessionId === PANEL_SESSION_ID
    && (message.sourceTransport === 'desktop-chat-ui' || message.senderRole === 'owned-agent'))
    .map((message, index) => ({ ...mapCanonicalMessage(message, identities, state.profile.humanIdentityId)!, id: `native-${index}`, entryId: `native-${index}` }) as Message);
  const native = conversation({ id: PANEL_SESSION_ID, canonicalSessionId: PANEL_SESSION_ID, type: 'owned-agent', desktopRuntimeBacked: true, desktopRuntimeTranscriptLoaded: true, messages: runtime });
  const visibleText = (message: Message) => message.turn?.assistantText || message.text;
  const expected = ['hii', 'Hi! How can I help?', 'hiiii', 'hihiihi', 'hihi', 'panel test one: reply with the word pong'];
  assert.deepEqual(model.messages(PANEL_SESSION_ID).map(visibleText), expected, 'The Cloud echo of the first request is the same request');
  assert.deepEqual(model.applyConversation(native, () => '').messages.map(visibleText), expected);
});

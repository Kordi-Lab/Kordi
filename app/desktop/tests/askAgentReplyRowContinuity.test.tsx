import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CloudAccount, CloudMessage } from '../src/features/cloud/authClient';
import { encodeCloudAgentResponse } from '../src/features/cloud/cloudAgentMessages';
import { encodeCloudDirectMessageEnvelope } from '../src/features/cloud/cloudDirectMessages';
import { projectCloudSelfAgentLiveTurns } from '../src/features/cloud/cloudGroupLiveProjection';
import { cloudSelfAgentRequestClientMessageId } from '../src/features/cloud/cloudSelfAgentIdentity';
import { projectPendingSelfAgentReplies } from '../src/features/cloud/cloudSelfAgentPendingReply';
import { cloudSelfAgentLocalTurnsToOmit, cloudSelfAgentTerminalOrLocalRequestIds, omitTerminalCloudSelfAgentLocalTurns } from '../src/features/cloud/cloudSelfAgentExecutionState';
import { planCloudSelfAgentCanonicalSync } from '../src/features/cloud/cloudSelfAgentCanonicalSync';
import { cloudSelfAgentStoppedReply, settledCloudSelfAgentTurn } from '../src/features/cloud/cloudSelfAgentTerminalReply';
import { createCloudSelfAgentTurnPresenter } from '../src/features/cloud/cloudSelfAgentTurnPresentation';
import { removeHostedSelfAgentProgress, updateHostedSelfAgentProgress } from '../src/features/cloud/hostedSelfAgentRunProgress';
import { createCanonicalSessionReadModel } from '../src/features/canonical/sessionReadModel';
import type { CanonicalSessionMessage, CanonicalSessionState, DesktopChatTurnSnapshot } from '../src/kordi-app/types';
import type { ChatSessionPaneProps } from '../src/pages/chatsPage.types';
import { cloudAccountAvatarFixture } from './helpers/cloudAccountAvatarFixture';

// The sequence an Ask Agent request went through in the owner's preview on
// 2026-10-19 (trace build): the Mac's native turn, the server's progress rows
// and the stored transcript rows, with their recorded order. Each step is
// rendered through the real session pane and must show one continuous
// processing row from send to the single final reply.

const account: CloudAccount = {
  accountId: 'acct_me', displayName: 'Owner', primaryEmail: 'owner@example.com', avatarUrl: null,
  avatar: cloudAccountAvatarFixture, nodeId: 'node_me', passwordSet: true,
};
const sessionId = '00000000-0000-4000-8000-0000000000cc';
const agentId = 'agent:cloud-self:acct_me';
const route = { model: 'openai-codex/gpt', authProvider: 'openai', authChoice: 'cloud-login:synthetic', thinking: 'high' };
const sentAtMs = Date.now() - 5_000;
const wireRequestId = '01a1566c-da8d-78e3-bd15-000000000001';
const localRequest: CanonicalSessionMessage = {
  id: 'msg:ui:request', sessionId, senderIdentityId: 'human:acct_me', senderRole: 'user', messageKind: 'text',
  contentText: 'hello, reply in one short sentence', content: { agentRuntimeRoute: route, deliveryState: 'sent', attachments: [], mentions: [] },
  parentMessageId: null, delegatedExchangeId: null, status: 'sent', sequenceNum: 1,
  createdAtMs: sentAtMs, updatedAtMs: sentAtMs, sourceTransport: 'desktop-chat-ui', sourceEventId: `desktop-chat-ui:${sessionId}:1`,
};
const baseState = {
  storagePath: '/tmp/canonical.sqlite3',
  profile: { id: 'profile', displayName: 'Owner', humanIdentityId: 'human:acct_me', storageRoot: '/tmp', createdAtMs: 1, updatedAtMs: 1 },
  identities: [
    { id: 'human:acct_me', kind: 'human', displayName: 'Owner', source: 'local', avatarKey: 'me', createdAtMs: 1, updatedAtMs: 1 },
    { id: agentId, kind: 'agent', displayName: 'Agent', source: 'cloud', ownerIdentityId: 'human:acct_me', avatarKey: 'agent', createdAtMs: 1, updatedAtMs: 1 },
  ],
  sessions: [{ id: sessionId, kind: 'self-agent', title: 'Hello', status: 'active', createdByIdentityId: 'human:acct_me',
    primaryIdentityId: agentId, relationshipIdentityId: null, metadata: {}, createdAtMs: sentAtMs - 10, updatedAtMs: sentAtMs, lastMessageAtMs: sentAtMs }],
  participants: [
    { sessionId, identityId: 'human:acct_me', role: 'self', state: 'active', addedByIdentityId: 'human:acct_me', addedAtMs: 1 },
    { sessionId, identityId: agentId, role: 'owned-agent', state: 'active', addedByIdentityId: 'human:acct_me', addedAtMs: 1 },
  ],
  messages: [localRequest], delegatedExchanges: [], presence: [], contextSnapshots: [],
} as unknown as CanonicalSessionState;

const cloud = (messageId: string, body: string, offsetMs: number, extra: Partial<CloudMessage> = {}): CloudMessage => ({
  messageId, fromAccountId: account.accountId, toAccountId: account.accountId, body, sessionId,
  createdAt: new Date(sentAtMs + offsetMs).toISOString(), deliveredAt: null, readAt: null, ...extra,
});
const serverRequest = cloud(wireRequestId, encodeCloudDirectMessageEnvelope({
  schemaVersion: 1, kind: 'message', text: localRequest.contentText, agentRuntimeRoute: route,
}), 800, { clientMessageId: cloudSelfAgentRequestClientMessageId(sessionId, localRequest.id) });
const progress = (messageId: string, text: string, offsetMs: number, deliveryState: 'processing' | 'complete' | 'cancelled' = 'processing', ending?: 'stopped') => cloud(
  messageId,
  encodeCloudAgentResponse({
    requestId: wireRequestId, text, deliveryState, ending,
    execution: {
      phase: deliveryState === 'processing' ? (text ? 'writing' : 'preparing') : deliveryState,
      summary: 'Working', steps: [], startedAtMs: sentAtMs + 1_770, updatedAtMs: sentAtMs + offsetMs,
      completed: deliveryState !== 'processing',
    },
  }),
  offsetMs,
);

/** Applies a canonical sync plan the way the store does: rows upsert by id. */
function applyPlan(state: CanonicalSessionState, messages: CloudMessage[]): CanonicalSessionState {
  const plan = planCloudSelfAgentCanonicalSync({ account, messages, state });
  let rows = [...state.messages];
  for (const reconciliation of plan.mirrorReconciliations) rows = rows.filter((row) => row.id !== reconciliation.duplicateMessageId);
  for (const request of plan.messageRequests) {
    const existing = rows.find((row) => row.id === request.id);
    const row: CanonicalSessionMessage = {
      id: request.id ?? '', sessionId: request.sessionId, senderIdentityId: request.senderIdentityId,
      senderRole: request.senderRole, messageKind: request.messageKind, contentText: request.contentText,
      content: request.content, parentMessageId: request.parentMessageId ?? null, delegatedExchangeId: null,
      status: request.status ?? 'sent', sequenceNum: existing?.sequenceNum ?? rows.length + 1,
      createdAtMs: request.createdAtMs ?? Date.now(), updatedAtMs: Date.now(),
      sourceTransport: request.sourceTransport ?? null, sourceEventId: request.sourceEventId ?? null,
    };
    rows = existing ? rows.map((candidate) => (candidate.id === row.id ? row : candidate)) : [...rows, row];
  }
  return { ...state, messages: rows };
}

const nativeTurn = (status: string, text: string, completed = false, succeeded = completed): DesktopChatTurnSnapshot => ({
  id: '510dc89f-bf03-4ed1-b067-bf319c2b499e', sessionId, prompt: localRequest.contentText, status, message: status === 'starting' ? 'Working…' : '',
  assistantText: text, thinkingText: '', tools: [], completed, succeeded, startedAtMs: sentAtMs + 1_770, replyToMessageId: wireRequestId,
});

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://desktop.kordi.test' });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  target.window = dom.window;
  target.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  for (const key of ['HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent'] as const) target[key] = dom.window[key];
  target.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  target.IS_REACT_ACT_ENVIRONMENT = true;
  const requestAnimationFrame = (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0);
  const cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
  target.requestAnimationFrame = requestAnimationFrame;
  target.cancelAnimationFrame = cancelAnimationFrame;
  dom.window.requestAnimationFrame = requestAnimationFrame;
  dom.window.cancelAnimationFrame = cancelAnimationFrame;
  // The virtual transcript renders rows only inside a measured viewport; jsdom has no layout.
  const proto = dom.window.HTMLElement.prototype;
  const isViewport = (element: Element) => element.hasAttribute('data-virtual-transcript-scroll');
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return isViewport(this) ? 800 : 40; } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get() { return isViewport(this) ? 800 : 40; } });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return isViewport(this) ? 2000 : 40; } });
  proto.getBoundingClientRect = function () {
    const height = isViewport(this) ? 800 : 40;
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON() { return {}; } } as DOMRect;
  };
  class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
  target.ResizeObserver = NoopResizeObserver;
  (dom.window as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopResizeObserver;
}

let ChatSessionPane: typeof import('../src/pages/chatsPage.sessionPane').ChatSessionPane;
test.before(async () => {
  installDom();
  ({ ChatSessionPane } = await import('../src/pages/chatsPage.sessionPane'));
});

type Scene = { state: CanonicalSessionState; wire: CloudMessage[]; turns: Record<string, DesktopChatTurnSnapshot> };

/** Renders the pane the way the app does: stored rows, the Mac's turn and the pending reply. */
function paneMessages(scene: Scene) {
  const kept = omitTerminalCloudSelfAgentLocalTurns(scene.turns, cloudSelfAgentLocalTurnsToOmit(
    cloudSelfAgentTerminalOrLocalRequestIds(scene.wire, scene.state), scene.wire, scene.state,
  ));
  scene.turns = kept;
  const projected = projectPendingSelfAgentReplies(projectCloudSelfAgentLiveTurns(scene.state, kept), Date.now(), { turns: kept, cloudMessages: scene.wire })!;
  return createCanonicalSessionReadModel(projected as never).messages(sessionId);
}

const scrollRef = createRef<HTMLDivElement>();
const actions: ChatSessionPaneProps['actions'] = {
  onOpenSource: () => {}, onOpenArtifact: () => {}, onOpenAuthSettings: () => {},
  onStopCollaborationAgentRequest: () => {}, onStopActiveTurn: () => true,
};

type Rendered = { agentRows: HTMLElement[]; stop: boolean; wave: boolean; text: string; userBubbles: number; status: string | null };

async function renderScene(root: Root, host: HTMLElement, scene: Scene): Promise<Rendered> {
  const messages = paneMessages(scene);
  await act(async () => root.render(
    <ChatSessionPane
      presentation={{ liveTurnSender: 'Agent', shouldRenderLiveTurn: false, densityMode: 'default' }}
      actions={actions}
      selection={{}}
      viewport={{
        sessionKey: sessionId, messages, queuedMessages: [], scrollRef, scrollClassName: 'test-scroll',
        hasOlderMessages: false, onLoadOlderMessages: () => {}, composer: <div data-composer="true" />,
      }}
    />,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
  const cards = [...host.querySelectorAll<HTMLElement>('[data-live-turn-status]')];
  const agentRows = cards.map((card) => card.closest<HTMLElement>('[data-transcript-message-root="true"]') ?? card);
  return {
    agentRows,
    stop: host.querySelector('[data-agent-request-stop]') !== null,
    wave: host.querySelector('.app-agent-waiting-wave') !== null,
    text: agentRows.map((row) => row.textContent ?? '').join('\n'),
    userBubbles: messages.filter((message) => message.role === 'user' && message.text === localRequest.contentText).length,
    status: cards[0]?.getAttribute('data-live-turn-status') ?? null,
  };
}

/** A running row shows its stop and either the waiting indicator or the text streamed so far. */
function expectRunning(label: string, rendered: Rendered, streamedText = '') {
  assert.equal(rendered.agentRows.length, 1, `${label}: ${rendered.agentRows.length} agent rows`);
  assert.equal(rendered.userBubbles, 1, `${label}: one user bubble`);
  if (streamedText) assert.ok(rendered.text.includes(streamedText), `${label}: the streamed text shows (status ${rendered.status})`);
  else assert.equal(rendered.wave, true, `${label}: the processing indicator shows (status ${rendered.status})`);
  assert.equal(rendered.stop, true, `${label}: the stop control shows (status ${rendered.status})`);
}

function expectSettled(label: string, rendered: Rendered, text: string) {
  assert.equal(rendered.agentRows.length, 1, `${label}: ${rendered.agentRows.length} agent rows`);
  assert.equal(rendered.userBubbles, 1, `${label}: one user bubble`);
  assert.equal(rendered.wave, false, `${label}: no processing indicator after the end (status ${rendered.status})`);
  assert.equal(rendered.stop, false, `${label}: no stop control after the end (status ${rendered.status})`);
  assert.ok(rendered.text.includes(text), `${label}: the reply text shows`);
}

async function withPane(run: (root: Root, host: HTMLElement) => Promise<void>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await run(root, host);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

test('the recorded Ask Agent run shows one continuous processing row until its single reply', async () => {
  await withPane(async (root, host) => {
    const scene: Scene = { state: baseState, wire: [], turns: {} };
    const turns = createCloudSelfAgentTurnPresenter({
      requestMessageId: wireRequestId, sessionId, canPresent: () => true,
      setLocalTurns: (update) => { scene.turns = update(scene.turns); },
    });
    let row: HTMLElement | null = null;
    const check = async (label: string, expect: (rendered: Rendered) => void, options: { newRow?: boolean } = {}) => {
      const rendered = await renderScene(root, host, scene);
      expect(rendered);
      if (row && !options.newRow) assert.equal(rendered.agentRows[0], row, `${label}: the reply row was replaced instead of updated in place`);
      row = rendered.agentRows[0] ?? null;
    };
    await check('sent (T+0.0 s)', (r) => expectRunning('sent', r));
    // T+0.8 s: the request is published and linked to its Cloud id. The row takes the id its stored reply will have.
    scene.wire = [serverRequest];
    scene.state = { ...scene.state, messages: scene.state.messages.map((message) => (message.id === localRequest.id
      ? { ...message, content: { ...(message.content as object), desktopEntryId: wireRequestId } } : message)) };
    await check('published', (r) => expectRunning('published', r), { newRow: true });
    // T+1.6 s: the server created the run and holds it for this Mac; the hosted progress hook tracks it.
    scene.state = updateHostedSelfAgentProgress(scene.state, { request: serverRequest, runStatus: 'queued', cloudMessages: scene.wire })!;
    await check('hosted run queued (T+1.6 s)', (r) => expectRunning('hosted queued', r));
    turns.remember(nativeTurn('starting', ''));
    await check('native turn starting (T+1.8 s)', (r) => expectRunning('starting', r));
    scene.state = updateHostedSelfAgentProgress(scene.state, { request: serverRequest, runStatus: 'leased', cloudMessages: scene.wire })!;
    await check('hosted run leased while the turn starts', (r) => expectRunning('hosted leased', r));
    turns.remember(nativeTurn('preparing', ''));
    await check('preparing', (r) => expectRunning('preparing', r));
    scene.wire = [...scene.wire, progress('progress-1', '', 2_160)];
    await check('first progress row indexed (T+2.2 s)', (r) => expectRunning('progress indexed', r));
    scene.state = removeHostedSelfAgentProgress(scene.state, wireRequestId)!;
    await check('hosted progress stops (T+2.8 s)', (r) => expectRunning('hosted stopped', r));
    scene.state = applyPlan(scene.state, scene.wire);
    await check('stored processing row (T+5.1 s)', (r) => expectRunning('stored row', r));
    turns.remember(nativeTurn('streaming', ''));
    await check('streaming (T+7.3 s)', (r) => expectRunning('streaming', r));
    turns.remember(nativeTurn('writing', 'Hello, how'));
    await check('writing (T+9.7 s)', (r) => expectRunning('writing', r, 'Hello, how'));
    turns.remember(nativeTurn('succeeded', 'Hello, how can I help?', true));
    await check('native turn done (T+10.5 s)', (r) => expectSettled('turn done', r, 'Hello, how can I help?'));
    scene.wire = [...scene.wire, progress('progress-2', 'Hello, how', 11_200)];
    await check('stale progress indexed after the end (T+11.2 s)', (r) => expectSettled('stale progress', r, 'Hello, how can I help?'));
    turns.settle(settledCloudSelfAgentTurn(nativeTurn('succeeded', 'Hello, how can I help?', true), { deliveryState: 'complete', text: 'Hello, how can I help?' }));
    await check('settled (T+12.4 s)', (r) => expectSettled('settled', r, 'Hello, how can I help?'));
    scene.wire = [...scene.wire, progress('final', 'Hello, how can I help?', 13_600, 'complete')];
    await check('final reply indexed (T+13.6 s)', (r) => expectSettled('final indexed', r, 'Hello, how can I help?'));
    scene.state = applyPlan(scene.state, scene.wire.filter((message) => message.messageId !== 'final'));
    await check('stale progress row stored late', (r) => expectSettled('stale stored', r, 'Hello, how can I help?'));
    scene.state = applyPlan(scene.state, scene.wire);
    await check('stored final reply (T+15.3 s)', (r) => expectSettled('stored final', r, 'Hello, how can I help?'));
    assert.deepEqual(scene.turns, {}, 'the turn goes once the stored reply is terminal');
    await check('turn dropped (T+16.7 s)', (r) => expectSettled('turn dropped', r, 'Hello, how can I help?'));
  });
});

test('a stop settles the Ask Agent row once and it never shows running again', async () => {
  await withPane(async (root, host) => {
    const scene: Scene = { state: baseState, wire: [serverRequest], turns: {} };
    scene.state = { ...scene.state, messages: scene.state.messages.map((message) => (message.id === localRequest.id
      ? { ...message, content: { ...(message.content as object), desktopEntryId: wireRequestId } } : message)) };
    const turns = createCloudSelfAgentTurnPresenter({
      requestMessageId: wireRequestId, sessionId, canPresent: () => true,
      setLocalTurns: (update) => { scene.turns = update(scene.turns); },
    });
    let row: HTMLElement | null = null;
    const check = async (label: string, expect: (rendered: Rendered) => void) => {
      const rendered = await renderScene(root, host, scene);
      expect(rendered);
      if (row) assert.equal(rendered.agentRows[0], row, `${label}: the reply row was replaced instead of updated in place`);
      row = rendered.agentRows[0] ?? null;
    };
    turns.remember(nativeTurn('starting', ''));
    await check('starting', (r) => expectRunning('starting', r));
    scene.wire = [...scene.wire, progress('progress-1', '', 2_160)];
    scene.state = applyPlan(scene.state, scene.wire);
    turns.remember(nativeTurn('writing', 'Hello, how'));
    await check('writing on the stored row', (r) => expectRunning('writing', r, 'Hello, how'));
    // The owner stops. The reply settles at once.
    turns.stop();
    await check('stop requested', (r) => expectSettled('stop requested', r, 'Hello, how'));
    turns.remember(nativeTurn('cancelling', 'Hello, how'));
    await check('native turn cancelling', (r) => expectSettled('cancelling', r, 'Hello, how'));
    turns.remember(nativeTurn('cancelled', 'Hello, how', true, false));
    await check('native turn cancelled', (r) => expectSettled('cancelled', r, 'Hello, how'));
    turns.settle(settledCloudSelfAgentTurn(nativeTurn('cancelled', 'Hello, how', true, false), cloudSelfAgentStoppedReply('Hello, how')));
    await check('settled as stopped', (r) => expectSettled('settled', r, 'Hello, how'));
    scene.wire = [...scene.wire, progress('progress-2', 'Hello, how', 9_000), progress('stopped', 'Hello, how', 10_000, 'cancelled', 'stopped')];
    await check('stopped reply indexed with a late progress row', (r) => expectSettled('indexed', r, 'Hello, how'));
    scene.state = applyPlan(scene.state, scene.wire.filter((message) => message.messageId !== 'stopped'));
    await check('late progress row stored', (r) => expectSettled('late stored', r, 'Hello, how'));
    scene.state = applyPlan(scene.state, scene.wire);
    await check('stored stopped reply', (r) => expectSettled('stored stopped', r, 'Hello, how'));
    assert.deepEqual(scene.turns, {}, 'the turn goes once the stored reply is terminal');
    await check('turn dropped', (r) => expectSettled('turn dropped', r, 'Hello, how'));
  });
});

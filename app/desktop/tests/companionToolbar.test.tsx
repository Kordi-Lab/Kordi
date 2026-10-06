import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { Activity, act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MainChatHeader } from '../src/pages/chatsPage.mainHeader';
import { NativeChatTitlebarContext } from '../src/app/nativeChatTitlebarContext';
import { NativeTitlebar } from '../src/app/NativeTitlebar';
import { CompanionToolbar, type CompanionView } from '../src/pages/chatsPage.companionToolbar';
import { CompanionCalendar, CompanionOverviewContent } from '../src/pages/chatsPage.companionOverview';
import { companionAgendaDays } from '../src/pages/chatsPage.companionCalendarModel';
import { useChatCompanionLayout } from '../src/pages/useChatCompanionLayout';
import { useChatCompanionSession } from '../src/pages/useChatCompanionSession';
import { mergeBackgroundDesktopChatState } from '../src/features/chat/desktopChatStateReducers';
import { useDesktopChatState } from '../src/features/chat/useDesktopChatState';
import type { DesktopChatState, DesktopChatTurnSnapshot, Message } from '../src/kordi-app/types';
import type { Conversation } from '../src/kordi-app/types';
import type { CalendarEvent } from '../src/features/digest/types';
import type { DigestState } from '../src/features/digest/store';

function installDom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const replacements = { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(document.getElementById('root')!);
  return { root, dom, async cleanup() {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  } };
}
const agent: Conversation = { id: 'agent-session', name: 'Agent', type: 'owned-agent', subtitle: 'Agent session', unread: 0, collaborationSources: ['local'], trust: 'Owned', directness: 'Direct chat', participants: ['Agent'], messages: [] };
const human: Conversation = { ...agent, id: 'human-session', type: 'human', name: 'Design chat' };

test('panel switching and hiding retain the agent session, draft, and mounted input', async () => {
  const { root, dom, cleanup } = installDom();
  let chat!: ReturnType<typeof useChatCompanionSession>;
  let layout!: ReturnType<typeof useChatCompanionLayout>;
  function Harness() {
    const [view, setView] = useState<CompanionView>('chat');
    chat = useChatCompanionSession({ activeConversation: human, conversations: [human, agent], activePaneKind: 'human', setComposerTextForSession: () => {}, onSendChatMessage: () => {} });
    layout = useChatCompanionLayout({ pageConversationId: human.id, activePaneKind: 'human', companionConversation: chat.conversation, hasOverview: view !== 'chat' });
    return <>
      <CompanionToolbar view={view} isOpen={layout.isVisible} canOpenChat hasChat={Boolean(chat.conversation)}
        onSelect={next => { setView(next); layout.placeCompanion('right'); layout.setFolded(false); }}
        onHide={() => layout.setFolded(true)} />
      <Activity mode={layout.isVisible && view === 'chat' ? 'visible' : 'hidden'}><textarea aria-label="Agent draft" defaultValue="Unsent attachment note" /></Activity>
    </>;
  }
  const click = async (label: string) => { await act(() => (document.querySelector(`[aria-label="${label}"]`) as HTMLElement).click()); };
  try {
    await act(() => root.render(<Harness />));
    await act(async () => { await chat.actions.open(); });
    assert.equal(chat.conversation?.id, agent.id);
    await act(() => chat.actions.updateDraft(agent.id, 'Keep this draft'));
    const input = document.querySelector('textarea');
    await click('Calendar');
    assert.equal(layout.isVisible, true);
    assert.equal(layout.side, 'right');
    await act(() => layout.onDividerKeyDown({ key: 'ArrowLeft', preventDefault() {} } as React.KeyboardEvent<HTMLDivElement>));
    assert.equal(layout.splitPercent, 45);
    await act(() => layout.onDividerKeyDown({ key: 'Home', preventDefault() {} } as React.KeyboardEvent<HTMLDivElement>));
    assert.equal(layout.splitPercent, 50);
    assert.equal(document.querySelector('[aria-label="Calendar"]')?.getAttribute('aria-pressed'), 'true');
    await click('Digest');
    await click('Digest');
    assert.equal(layout.isVisible, false);
    assert.equal(document.querySelector('[aria-label="Digest"]')?.getAttribute('aria-pressed'), 'false');
    await click('Chat');
    assert.equal(document.querySelector('textarea'), input);
    assert.equal(input?.value, 'Unsent attachment note');
    assert.equal(chat.draftText, 'Keep this draft');
    assert.equal(document.querySelector('.app-companion-more'), null);
    assert.equal(document.querySelectorAll('.app-companion-toolbar button').length, 3);
    // The second click of a double click must not reopen the panel.
    for (const detail of [1, 2]) {
      await act(() => document.querySelector('[aria-label="Chat"]')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail })));
    }
    assert.equal(layout.isVisible, false);
    await click('Calendar');
    assert.equal(layout.isVisible, true);
    await click('Calendar');
    assert.equal(layout.isVisible, false);
    await click('Chat');
    assert.equal(chat.draftText, 'Keep this draft');
  } finally { await cleanup(); }
});

test('sending and hydrating a completed side chat preserve its open panel and main selection', async () => {
  const { root, dom, cleanup } = installDom();
  const detail = (id: string, complete = false) => ({
    id, title: id, provider: 'openai', model: 'fixture', thinking: 'high', messageCount: complete ? 2 : 1,
    messages: [{ entryId: 'request', role: 'user', text: 'side request', timestampMs: 1, timeLabel: '10:00' },
      ...(complete ? [{ entryId: 'response', role: 'assistant', text: 'side response', timestampMs: 2, timeLabel: '10:00' }] : [])],
  });
  const state = (id: string, complete = false) => ({ activeSessionId: id, activeSession: detail(id, complete),
    sessions: [{ id: human.id, messageCount: 1 }, { id: agent.id, messageCount: complete ? 2 : 1 }], projects: [],
  }) as unknown as DesktopChatState;
  let complete = false;
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { activeSessionId?: string; sessionId?: string }) => {
    if (command === 'cloud_session_load') return null;
    if (command === 'desktop_chat_state') return state(args.activeSessionId ?? human.id, complete);
    if (command === 'desktop_chat_session_detail') return detail(args.sessionId!, complete);
    return [];
  } } });
  const map = (_id: string, messages: DesktopChatState['activeSession']['messages']) => messages.map(message => ({
    id: message.entryId, role: message.role === 'assistant' ? 'owned-agent' : 'user', text: message.text, time: message.timeLabel,
  } as Message));
  let runtime!: ReturnType<typeof useDesktopChatState>;
  let chat!: ReturnType<typeof useChatCompanionSession>;
  let layout!: ReturnType<typeof useChatCompanionLayout>;
  let send!: Promise<void>;
  function Harness() {
    runtime = useDesktopChatState({ isNativeShell: true, mapDesktopMessages: map });
    const active = runtime.desktopChatState?.activeSessionId === agent.id ? agent : human;
    chat = useChatCompanionSession({ activeConversation: active, conversations: [human, agent], activePaneKind: 'human',
      setComposerTextForSession: () => {}, onCreateAgentSession: undefined, onPrefetchChatSession: undefined,
      onSendChatMessage: (_text, id) => { send = (async () => {
        runtime.setDesktopChatState(current => mergeBackgroundDesktopChatState(current, state(id!)));
        await runtime.preloadDesktopSessionTranscript(id!);
      })(); },
    });
    layout = useChatCompanionLayout({ pageConversationId: active.id, activePaneKind: 'human', companionConversation: chat.conversation });
    return <div data-panel-open={layout.isVisible} data-main={active.id}>{chat.conversation?.name}</div>;
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => { await chat.actions.open(); });
    await act(() => chat.actions.updateDraft(agent.id, 'side request'));
    await act(async () => { assert.equal(chat.actions.sendDraft(agent, []), true); await send; });
    assert.equal(layout.isVisible, true);
    assert.equal(chat.conversation?.id, agent.id);
    assert.equal(runtime.desktopChatState?.activeSessionId, human.id);
    complete = true;
    const turn = { id: 'side-turn', sessionId: agent.id, prompt: 'side request', status: 'complete', message: 'Complete',
      assistantText: 'side response', thinkingText: '', tools: [], completed: true, succeeded: true, transcriptEntryId: 'response',
    } as DesktopChatTurnSnapshot;
    await act(async () => { await runtime.watchDesktopLiveTurn(turn); });
    assert.equal(layout.isVisible, true, 'The panel stays open after persisted transcript hydration');
    assert.equal(runtime.desktopChatState?.activeSessionId, human.id);
    assert.deepEqual(runtime.cachedChatSessionMessages[agent.id]?.map(message => message.text), ['side request', 'side response']);
  } finally { await cleanup(); }
});

const event = (value: Partial<CalendarEvent>): CalendarEvent => ({ id: 'event', title: 'Review', startAt: '2026-09-29T10:00:00Z', allDay: false, sourceIds: [], description: '', revision: 1, ...value });
test('agenda groups all-day spans with exclusive end dates and sorts timed events after all-day events', () => {
  const days = companionAgendaDays('2026-09-29', [event({ id: 'late', startAt: '2026-09-29T14:00:00' }), event({ id: 'all-day', startAt: '2026-09-29T00:00:00Z', endAt: '2026-10-01T00:00:00Z', allDay: true }), event({ id: 'early', startAt: '2026-09-29T08:00:00' })]);
  assert.deepEqual(days[0].events.map(item => item.id), ['all-day', 'early', 'late']);
  assert.deepEqual(days[1].events.map(item => item.id), ['all-day']);
  assert.deepEqual(days[2].events, []);
  assert.equal(days.at(-1)?.day, '2026-10-05');
});

test('calendar supports keyboard date selection and honest read errors', async () => {
  const { root, dom, cleanup } = installDom();
  try {
    await act(() => root.render(<CompanionCalendar events={[]} loaded={false} error="offline" onRetry={() => {}} />));
    assert.match(document.body.textContent!, /Calendar is unavailable/);
    assert.doesNotMatch(document.body.textContent!, /No events scheduled/);
    const selected = document.querySelector('.app-companion-date-grid [aria-pressed="true"]') as HTMLElement;
    const before = selected.getAttribute('aria-label');
    await act(() => selected.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    const after = document.querySelector('.app-companion-date-grid [aria-pressed="true"]');
    assert.notEqual(after?.getAttribute('aria-label'), before);
    assert.equal(document.activeElement, after);
    await act(() => root.render(<CompanionCalendar events={[]} loaded error={null} onRetry={() => {}} />));
    assert.equal(document.querySelectorAll('.app-companion-agenda section').length, 7);
  } finally { await cleanup(); }
});

test('digest uses available snapshot and excludes dismissed entries', async () => {
  const { root, cleanup } = installDom();
  const state: DigestState = { events: [], calendarLoaded: false, calendarError: null, digestError: null, pendingMutationKeys: [], mutationError: null, canRetryMutation: false, digest: { accountId: 'self', status: 'ready', updatedAt: '', partial: false, revision: 1, sources: [], feedback: [{ id: 'hidden', status: 'dismissed' }], snapshot: { claims: [{ id: 'visible', title: 'Actual summary', text: 'Stored content', kind: 'claim', sourceIds: [] }, { id: 'hidden', title: 'Dismissed content', text: '', kind: 'claim', sourceIds: [] }], commitments: [], suggestions: [], calendarCandidates: [] } } };
  try {
    await act(() => root.render(<CompanionOverviewContent accountId="self" view="digest" state={state} onRetry={() => {}} />));
    assert.match(document.body.textContent!, /Actual summary/);
    assert.doesNotMatch(document.body.textContent!, /Dismissed content/);
  } finally { await cleanup(); }
});


test('native titlebar keeps rename and panel actions working and clears them when leaving chat', async () => {
  const { root, dom, cleanup } = installDom();
  let renameRequests = 0;
  let selected: CompanionView = 'chat';
  const noop = () => {};
  function Harness({ inChat }: { inChat: boolean }) {
    const [title, setTitle] = useState<HTMLDivElement | null>(null);
    const [actions, setActions] = useState<HTMLDivElement | null>(null);
    return <NativeChatTitlebarContext value={{ title, actions }}>
      <NativeTitlebar titleHostRef={setTitle} actionsHostRef={setActions} windowTitle="Kordi"
        leftWorkspaceWidth={296} collapseChatSessions={false} isDetailPanelCollapsed />
      <main>{inChat ? <MainChatHeader conversation={human}
        layout={{ showSessionToggle: false, sessionsCollapsed: false, onToggleSessions: noop, showDestinations: false, destination: 'messages', onSelectDestination: noop }}
        metadata={{ subtitle: 'Maya, you', forkSourceSessionId: 'source', forkSourceTitle: 'Original', onOpenForkSource: noop }}
        rename={{ enabled: true, editing: false, draft: '', sessionId: human.id, setDraft: noop, begin: () => { renameRequests += 1; }, cancel: noop, commit: noop }}
        companion={{ view: 'chat', isOpen: true, canOpenChat: true, hasChat: true, onSelect: view => { selected = view; }, onHide: noop }} /> : null}</main>
    </NativeChatTitlebarContext>;
  }
  try {
    await act(() => root.render(<Harness inChat />));
    const titlebar = document.querySelector('.app-native-titlebar')!;
    const rename = titlebar.querySelector<HTMLButtonElement>('[data-chat-session-title-rename]')!;
    assert.equal(rename.textContent, human.name);
    await act(() => rename.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })));
    assert.equal(renameRequests, 1);
    await act(() => titlebar.querySelector<HTMLButtonElement>('[aria-label="Calendar"]')!.click());
    assert.equal(selected, 'calendar');
    assert.equal(document.querySelector('main h2'), null);
    assert.match(document.querySelector('main')!.textContent!, /Maya, you.*Forked from Original/);
    await act(() => root.render(<Harness inChat={false} />));
    assert.equal(titlebar.querySelector('.app-chat-header-title'), null);
    assert.equal(titlebar.querySelector('.app-companion-toolbar'), null);
    assert.equal(titlebar.querySelector('.app-native-titlebar-fallback')?.textContent, 'Kordi');
  } finally { await cleanup(); }
});

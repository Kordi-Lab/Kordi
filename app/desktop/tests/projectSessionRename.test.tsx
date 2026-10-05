import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useKordiChatSessionActions } from '../src/app/useKordiChatSessionActions';
import { buildProjectRoutingGroups } from '../src/features/canonical/sessionResolver';
import type { CanonicalSessionState, DesktopChatState } from '../src/kordi-app/types';

test('renaming a project session updates its native title and keeps project membership', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  let canonical = {
    profile: { humanIdentityId: 'human:me' }, identities: [], participants: [], messages: [],
    sessions: [{ id: 'project-session', kind: 'project', title: 'Original title', status: 'active', projectId: 'project:/fixture/project', metadata: { projectRoot: '/fixture/project' } }],
  } as unknown as CanonicalSessionState;
  let desktop = {
    activeSessionId: 'project-session', activeSession: { id: 'project-session', title: 'Original title' },
    sessions: [], projects: [{ id: 'project:/fixture/project', root: '/fixture/project', name: 'Project', sessions: [{ id: 'project-session', title: 'Original title' }] }],
  } as unknown as DesktopChatState;
  const calls: string[] = [];
  Object.assign(dom.window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>) => {
    calls.push(command);
    if (command === 'desktop_canonical_rename_session') {
      const { title } = args.request as { title: string };
      return { ...canonical, sessions: canonical.sessions.map((session) => ({ ...session, title, metadata: { ...session.metadata as object, titleSource: 'manual' } })) };
    }
    if (command === 'desktop_chat_rename_session') {
      assert.equal(args.sessionId, 'project-session');
      return { ...desktop, activeSession: { ...desktop.activeSession, title: args.name }, projects: desktop.projects.map((project) => ({ ...project, sessions: project.sessions.map((session) => ({ ...session, title: args.name })) })) };
    }
    throw new Error(`Unexpected native command: ${command}`);
  } } });
  const root = createRoot(document.getElementById('root')!);
  let actions!: ReturnType<typeof useKordiChatSessionActions>;
  const noChange = () => {};
  const noAction = async () => {};
  let defaultRefreshes = 0;
  function Probe() {
    actions = useKordiChatSessionActions({
      account: null, activeConversationId: 'project-session', canonicalState: canonical, desktopState: desktop, isNativeShell: true,
      deleteCloudSession: noAction, hideCloudSession: noAction, unhideCloudSession: noAction,
      setCloudSessionPinned: noAction, setCloudSessionMuted: noAction, setCloudSessionUnread: noAction,
      markCloudSessionsRead: noAction, setCloudGroupSpacePinned: noAction, setCloudGroupSpaceMuted: noAction, setCloudGroupSpaceArchived: noAction,
      refreshCanonicalState: noAction, refreshDesktopChat: async () => { defaultRefreshes += 1; }, sendCloudGroupControl: noAction,
      setActiveConversationId: noChange, setComposerDrafts: noChange, setLocallyHiddenSessionIds: noChange,
      setCanonicalState: (value) => { canonical = (typeof value === 'function' ? value(canonical) : value)!; },
      setDesktopState: (value) => { desktop = (typeof value === 'function' ? value(desktop) : value)!; },
      setDesktopError: (value) => { assert.equal(value, null); },
    });
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => actions.renameSession('project-session', 'Renamed project task'));
    assert.deepEqual(calls, ['desktop_canonical_rename_session', 'desktop_chat_rename_session']);
    assert.equal(defaultRefreshes, 0);
    assert.equal(desktop.activeSession.title, 'Renamed project task');
    assert.equal(canonical.sessions[0].title, 'Renamed project task');
    assert.equal(canonical.sessions[0].kind, 'project');
    assert.deepEqual(buildProjectRoutingGroups(desktop.projects, canonical)[0].sessions, [{ id: 'project-session' }]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

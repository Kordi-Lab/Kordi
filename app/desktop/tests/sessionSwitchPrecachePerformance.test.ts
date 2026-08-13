import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { readKordiAppModelImplementationSource } from './helpers/appModelSource';

const workspaceViewModelSource = () => readFileSync(new URL('../src/app/useWorkspaceViewModels.ts', import.meta.url), 'utf8');
const appModelSource = readKordiAppModelImplementationSource;
const canonicalStoreSource = () => readFileSync(new URL('../src/app/useKordiCanonicalSessionStore.ts', import.meta.url), 'utf8');
const uiEffectsSource = () => readFileSync(new URL('../src/app/useKordiUiEffects.ts', import.meta.url), 'utf8');
const agentSidebarRowsSource = () => readFileSync(new URL('../src/pages/workspaceSidebar.agentRows.tsx', import.meta.url), 'utf8');
const contactSidebarRowsSource = () => readFileSync(new URL('../src/pages/workspaceSidebar.contactRows.tsx', import.meta.url), 'utf8');

test('canonical session selection pages only the selected transcript and never refreshes full state', () => {
  const source = canonicalStoreSource();
  assert.doesNotMatch(source, /desktopCanonicalRefreshKey|bridgeCanonicalRefreshKey/);
  assert.doesNotMatch(source, /fetchCanonicalSessionState/);
  assert.match(source, /activePageSessionIds/);
  assert.match(source, /hydrateSessionPage\(sessionId\)/);
  assert.match(source, /const CANONICAL_MESSAGE_PAGE_SIZE = 50/);
  assert.match(source, /fetchCanonicalSessionMessages\(\s*normalizedSessionId,\s*beforeSequenceNum,\s*CANONICAL_MESSAGE_PAGE_SIZE/);
});

test('canonical Cloud chat selection does not invoke native desktop chat reload', () => {
  const source = readFileSync(new URL('../src/features/chat/useDesktopSessionController.ts', import.meta.url), 'utf8');
  const handlerStart = source.indexOf('const handleSelectChatSession = useCallback(async (sessionId: string) => {');
  const handlerEnd = source.indexOf('  const handleCreateChatSession = useCallback', handlerStart);
  assert.notEqual(handlerStart, -1, 'expected chat selection handler');
  assert.notEqual(handlerEnd, -1, 'expected end of chat selection handler');
  const handler = source.slice(handlerStart, handlerEnd);
  const cloudGuardIndex = handler.indexOf('isCanonicalCloudSessionId(sessionId)');
  const refreshIndex = handler.indexOf('await refreshDesktopChat(sessionId)');

  assert.notEqual(cloudGuardIndex, -1, 'canonical Cloud session ids need a local-only selection fast path');
  assert.notEqual(refreshIndex, -1, 'local runtime session ids should still refresh native desktop chat');
  assert.ok(
    cloudGuardIndex < refreshIndex,
    'canonical Cloud session selection must return before native desktop_chat_state reload',
  );
});

test('canonical Cloud chat selection begins page hydration on the click path', () => {
  const source = readFileSync(new URL('../src/features/chat/useDesktopSessionController.ts', import.meta.url), 'utf8');
  const handlerStart = source.indexOf('const handleSelectChatSession = useCallback(async (sessionId: string) => {');
  const handlerEnd = source.indexOf('  const handleCreateChatSession = useCallback', handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.match(handler, /setActiveConvId\(sessionId\);[\s\S]*hydrateCanonicalSessionPage\(sessionId\)/);
});

test('sidebar session intent warms authoritative transcript state before selection', () => {
  for (const source of [agentSidebarRowsSource(), contactSidebarRowsSource()]) {
    assert.match(source, /onPointerEnter=.*onPrefetchChatSession/);
    assert.match(source, /onFocus=.*onPrefetchChatSession/);
  }
});

test('chat session changes reset transcript auto-follow before message hydration', () => {
  const source = uiEffectsSource();
  assert.match(source, /shouldAutoFollowChatRef\.current\s*=\s*true/, 'session changes should re-enable follow-to-bottom');
  assert.match(
    source,
    /\[activeConvId, activeNav, activeProjectSessionId,[^\]]*shouldAutoFollowChatRef\]/,
    'auto-follow reset should depend on selected chat/project identity',
  );
});

test('canonical chat hydration is cached independently from active session selection', () => {
  const source = workspaceViewModelSource();
  const warmedStart = source.indexOf('const hydratedChatConversations = useMemo(() => {');
  const visibleStart = source.indexOf('const chatConversations = useMemo(() => {', warmedStart);
  assert.notEqual(warmedStart, -1, 'expected warmed canonical chat conversation cache');
  assert.notEqual(visibleStart, -1, 'expected cheap selected-session visibility memo after warmed cache');

  const warmedEnd = source.indexOf('\n\n  const chatConversations = useMemo', warmedStart);
  const warmedMemo = source.slice(warmedStart, warmedEnd);
  const warmedDeps = warmedMemo.slice(warmedMemo.lastIndexOf('}, ['));

  assert.match(warmedMemo, /canonicalReadModel\.buildChatConversations/, 'warmed cache should do expensive canonical hydration');
  assert.doesNotMatch(warmedDeps, /activeConvId/, 'switching sessions must not rebuild expensive canonical hydration');

  const visibleMemo = source.slice(visibleStart, source.indexOf('\n\n  const activeConv', visibleStart));
  assert.match(visibleMemo, /blankShellCollapsedChatConversations/, 'visible conversations should reuse the stable decorated and blank-collapsed list');
  assert.match(visibleMemo, /activeConvId/, 'only the cheap visibility layer should depend on active selection');
});

test('session selection does not redecorate or regroup the complete conversation list', () => {
  const source = workspaceViewModelSource();
  const decoratedStart = source.indexOf('const decoratedChatConversations = useMemo(() => {');
  const visibleStart = source.indexOf('const chatConversations = useMemo(() => {', decoratedStart);
  assert.notEqual(decoratedStart, -1, 'expected stable conversation decoration memo');
  assert.notEqual(visibleStart, -1, 'expected selected-session visibility memo');

  const decoratedMemo = source.slice(decoratedStart, visibleStart);
  assert.match(decoratedMemo, /applyCloudPresenceToConversations/);
  assert.match(decoratedMemo, /hideRawConversationIds/);
  assert.doesNotMatch(decoratedMemo, /activeConvId/);

  const visibleMemo = source.slice(
    visibleStart,
    source.indexOf('\n\n  const nativeChatPlaceholder', visibleStart),
  );
  assert.match(visibleMemo, /if \(hiddenIds\.size === 0\) return blankShellCollapsedChatConversations/);
  assert.match(decoratedMemo, /collapseBlankConversationShells\(decoratedChatConversations\)/);
  assert.doesNotMatch(visibleMemo, /applyCloudPresenceToConversations|hideRawConversationIds/);
});

test('canonical hydration status does not rebuild the complete session read model', () => {
  const source = canonicalStoreSource();
  assert.match(source, /const \{ catalog, messagesBySessionId \} = store/);
  assert.match(source, /\}\), \[catalog, messagesBySessionId\]\)/);
  assert.doesNotMatch(source, /canonicalStateFromStore\(store\), \[store\]/);
});

test('older canonical transcript pages use the oldest loaded sequence cursor', () => {
  const source = canonicalStoreSource();
  const start = source.indexOf('const loadOlderSessionMessages = useCallback');
  const end = source.indexOf('\n\n  const refreshState', start);
  assert.notEqual(start, -1, 'expected an older-page loader');
  assert.notEqual(end, -1, 'expected catalog refresh after the older-page loader');
  const loader = source.slice(start, end);

  assert.match(loader, /message\.sequenceNum < oldest/);
  assert.match(loader, /beforeSequenceNum: oldestSequenceNum/);
  assert.match(
    appModelSource(),
    /canonicalHasOlderBySessionId:\s*(?:canonical\.)?canonicalStore\.hasOlderBySessionId/,
  );
});

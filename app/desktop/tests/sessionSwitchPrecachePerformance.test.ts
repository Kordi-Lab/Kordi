import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const workspaceViewModelSource = () => readFileSync(new URL('../src/app/useWorkspaceViewModels.ts', import.meta.url), 'utf8');

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
  assert.match(visibleMemo, /hydratedChatConversations/, 'visible conversations should reuse warmed canonical hydration');
  assert.match(visibleMemo, /activeConvId/, 'only the cheap visibility layer should depend on active selection');
});

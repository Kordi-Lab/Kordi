import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('native shell locks page scrolling at the document root', () => {
  const baseCss = readSource('../src/styles/base.css');
  const app = readSource('../src/App.jsx');

  assert.match(baseCss, /body\.kordi-native-shell\s*\{[\s\S]*overflow:\s*hidden;/);
  assert.match(baseCss, /body\.kordi-native-shell\s*\{[\s\S]*overscroll-behavior:\s*none;/);
  assert.match(baseCss, /html\.kordi-native-shell body #root\s*\{[\s\S]*background:\s*transparent;/);
  assert.match(app, /document\.documentElement\.classList\.toggle\('kordi-native-shell'/);
  assert.match(app, /document\.body\.classList\.toggle\('kordi-native-shell'/);
});

test('main app shell and chat transcript contain scroll to the intended axis', () => {
  const appShellFrame = readSource('../src/app/AppShellFrame.tsx');
  const scrollArea = readSource('../src/components/ui/scroll-area.jsx');
  const chatsPage = readSource('../src/pages/ChatsPage.tsx');
  const projectsPage = readSource('../src/pages/ProjectsPage.tsx');

  assert.match(appShellFrame, /kordi-app app-page-bg w-full min-w-0 max-w-full/);
  assert.match(appShellFrame, /app-shell relative flex min-w-0 max-w-full flex-col overflow-hidden/);
  assert.match(appShellFrame, /relative grid h-full min-w-0 flex-1 gap-0 overflow-hidden box-border/);
  assert.match(appShellFrame, /relative min-h-0 min-w-0 overflow-hidden/);
  assert.match(appShellFrame, /grid h-full min-h-0 min-w-0/);

  assert.match(scrollArea, /overflow-y-auto/);
  assert.match(scrollArea, /overflow-x-hidden/);
  assert.match(scrollArea, /overscroll-contain/);

  assert.match(chatsPage, /scrollClassName: 'min-h-0 flex-1 overflow-x-hidden overscroll-contain px-3\.5 py-5 sm:px-4'/);
  assert.match(chatsPage, /scrollClassName: 'min-h-0 flex-1 overflow-x-hidden overscroll-contain px-3 py-5'/);
  assert.match(projectsPage, /h-full min-h-0 overflow-x-hidden overscroll-contain px-3\.5 py-3/);
});

test('standalone auth popup is viewport-bound and scrolls only inside its panel body', () => {
  const authPopup = readSource('../src/AuthPopup.tsx');

  assert.match(authPopup, /kordi-app theme-dark flex h-\[100dvh\] w-full overflow-hidden/);
  assert.match(authPopup, /max-h-\[calc\(100dvh-4rem\)\] overflow-y-auto overflow-x-hidden overscroll-contain/);
});

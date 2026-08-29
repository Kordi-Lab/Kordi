import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readDesktopShellCss } from './helpers/readDesktopStyles';

function source(relativePath: string) {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

function cssBlock(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

test('split chat panes share one header, tab, and content geometry contract', () => {
  const chatsPage = source('pages/ChatsPage.tsx');
  const mainHeader = source('pages/chatsPage.mainHeader.tsx');
  const companionHeader = source('pages/chatsPage.companionHeader.tsx');
  const mainWorkspace = source('pages/chatsPage.mainWorkspace.tsx');
  const companionWorkspace = source('pages/chatsPage.companionWorkspace.tsx');
  const css = readDesktopShellCss();

  assert.match(chatsPage, /app-chat-split-workspace/);
  assert.match(chatsPage, /data-chat-split-workspace="true"/);

  for (const header of [mainHeader, companionHeader]) {
    assert.match(header, /app-page-header app-chat-pane-header/);
    assert.match(header, /app-chat-pane-title-row/);
    assert.match(header, /app-chat-pane-metadata-row/);
    assert.doesNotMatch(header, /min-h-\[84px\]|pb-8 pt-2\.5/);
  }

  const workspaceTokens = cssBlock(css, '.app-chat-split-workspace');
  assert.match(workspaceTokens, /--app-chat-pane-header-height:\s*5\.75rem/);
  assert.match(workspaceTokens, /--app-chat-pane-header-inline:\s*1rem/);
  assert.match(workspaceTokens, /--app-chat-pane-tab-height:\s*2\.125rem/);
  assert.match(workspaceTokens, /--app-chat-pane-detail-top:\s*0\.75rem/);

  const headerGeometry = cssBlock(css, '.app-chat-pane-header');
  assert.match(headerGeometry, /height:\s*var\(--app-chat-pane-header-height\)/);
  assert.match(headerGeometry, /min-height:\s*var\(--app-chat-pane-header-height\)/);
  assert.match(headerGeometry, /padding:[^;]*var\(--app-chat-pane-header-inline\)[^;]*var\(--app-chat-pane-tab-height\)/);

  const titleGeometry = cssBlock(css, '.app-chat-pane-title-row');
  assert.match(titleGeometry, /width:\s*100%/);
  assert.match(titleGeometry, /min-width:\s*0/);
  assert.match(companionHeader, /className="flex min-w-0 flex-1 items-center gap-2"/);
  assert.match(companionHeader, /app-chat-pane-title-row min-w-0 w-full truncate/);
  assert.doesNotMatch(companionHeader, /app-chat-pane-title-row[^"\n]*max-w-/);
  assert.doesNotMatch(mainHeader, /<h2 className="[^"]*max-w-/);

  const tabGeometry = cssBlock(css, '.app-chat-destination-tabs');
  assert.match(tabGeometry, /right:\s*var\(--app-chat-pane-header-inline\)/);
  assert.match(tabGeometry, /left:\s*var\(--app-chat-pane-header-inline\)/);
  assert.match(tabGeometry, /height:\s*var\(--app-chat-pane-tab-height\)/);

  for (const workspace of [mainWorkspace, companionWorkspace]) {
    assert.match(workspace, /app-chat-pane-transcript-scroll/);
  }
  const transcriptGeometry = cssBlock(css, '.app-chat-pane-transcript-scroll');
  assert.match(transcriptGeometry, /padding:\s*var\(--app-chat-pane-transcript-block\) var\(--app-chat-pane-transcript-inline\) 0\.25rem/);

  const detailGeometry = cssBlock(css, '.app-right-detail-page-content');
  assert.match(detailGeometry, /padding:\s*var\(--app-chat-pane-detail-top\) var\(--app-chat-pane-detail-inline\) 2\.5rem/);
});

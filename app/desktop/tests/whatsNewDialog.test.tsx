import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { WhatsNewDialog } from '../src/features/updates/WhatsNewDialog';
import type { WhatsNewRelease } from '../src/features/updates/whatsNew';

const release: WhatsNewRelease = {
  version: '0.0.1-beta.12',
  notes: [
    '### Added',
    '',
    '- Added a focused first-launch summary. ([#893])',
    '',
    '### Fixed',
    '',
    '- Kept the workspace available when release metadata cannot load.',
  ].join('\n'),
  publishedAt: '2026-08-08T00:00:00Z',
  changelogUrl: 'https://github.com/Kordi-AI/Kordi/releases/tag/V0.0.1.beta12',
};

const whatsNewCss = readFileSync(new URL('../src/styles/whats-new.css', import.meta.url), 'utf8');

test('What’s New renders concise highlights and both clear actions', () => {
  const markup = renderToStaticMarkup(createElement(WhatsNewDialog, {
    release,
    onDismiss: () => {},
    onOpenFullReleaseNotes: () => {},
  }));

  assert.match(markup, /What’s New in Kordi/);
  assert.match(markup, /2 product updates in the beta\.12 release/);
  assert.match(markup, /Social sign-in stays available in packaged Cloud builds/);
  assert.match(markup, /Group agents can mention people and their Kordi agents/);
  assert.match(markup, /View full changelog/);
  assert.match(markup, />Continue</);
  assert.match(markup, /aria-label="Close What’s New"/);
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.doesNotMatch(markup, /#893/);
  assert.doesNotMatch(markup, /release-signal|signal-node|aria-pressed/);
  assert.equal((markup.match(/role="listitem"/g) ?? []).length, 2);
  assert.equal((markup.match(/app-whats-new-footer-action/g) ?? []).length, 2);
});

test('What’s New sizes to its content while keeping a bounded, scrollable viewport', () => {
  assert.match(whatsNewCss, /--app-whats-new-width:/);
  assert.match(whatsNewCss, /--app-whats-new-max-height:/);
  assert.match(whatsNewCss, /height:\s*auto;/);
  assert.match(whatsNewCss, /max-height:\s*var\(--app-whats-new-max-height\);/);
  assert.match(whatsNewCss, /\.app-whats-new-layout\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
  assert.match(whatsNewCss, /\.app-whats-new-content\s*\{[\s\S]*?align-content:\s*start;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(whatsNewCss, /\.app-whats-new-footer-action\s*\{[\s\S]*?min-height:\s*2\.25rem;[\s\S]*?font-size:\s*0\.6875rem;/);
  assert.doesNotMatch(whatsNewCss, /height:\s*var\(--app-whats-new-size\)/);
  assert.doesNotMatch(whatsNewCss, /align-content:\s*center/);
});

test('What’s New focuses Continue, reports presentation, and dismisses with Escape', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.querySelector('#root') as HTMLElement;
  let root: Root | null = createRoot(host);
  let dismissed = 0;
  let presented = 0;
  try {
    await act(async () => {
      root?.render(createElement(WhatsNewDialog, {
        release,
        onDismiss: () => { dismissed += 1; },
        onPresented: () => { presented += 1; },
      }));
    });

    assert.equal(presented, 1);
    assert.equal(dom.window.document.activeElement?.textContent, 'Continue');
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }));
    });
    assert.equal(dismissed, 1);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test('the launch window is mounted only after sign-in and initial sync are ready', () => {
  const source = readFileSync(new URL('../src/KordiApp.tsx', import.meta.url), 'utf8');
  const signInGate = source.indexOf('shouldShowCloudLoginGate');
  const signedInShell = source.indexOf('<KordiAppShell');
  const readyGuard = source.indexOf("cloudInitialSync.status !== 'ready'");
  const launchWindow = source.indexOf('<WhatsNewLaunchWindow />');

  assert.ok(signInGate >= 0);
  assert.ok(signedInShell > signInGate);
  assert.ok(readyGuard >= 0);
  assert.ok(launchWindow > signedInShell);
  assert.ok(launchWindow > readyGuard);
});

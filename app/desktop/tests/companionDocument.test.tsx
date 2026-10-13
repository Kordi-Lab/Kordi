import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, useState } from 'react';

import { openArtifactInCompanion } from '../src/features/documents/companionDocument';
import { DocumentReaderHostContext, type DocumentReaderHost } from '../src/features/documents/documentReaderHost';
import { useCompanionDocument, useCompanionDocumentRequests } from '../src/features/documents/useCompanionDocument';
import type { SessionArtifact } from '../src/kordi-app/types';
import { ArtifactInspector } from '../src/pages/ArtifactInspector';
import { CompanionDocumentPane } from '../src/pages/chatsPage.companionDocument';
import { CompanionToolbar, type CompanionView } from '../src/pages/chatsPage.companionToolbar';
import { createMemoryDocumentApi } from './helpers/documentReaderFixtures';
import { withJsdomRoot } from './helpers/mountWithJsdom';

const host: DocumentReaderHost = { viewer: null, sessionId: 'session_example', agentName: 'Lab agent', people: [] };

const artifacts: SessionArtifact[] = [
  { id: 'notes/related-work.md', path: 'notes/related-work.md', name: 'related-work.md', kind: 'document', category: 'artifact', summary: 'Created' },
  { id: 'notes/plan.md', path: 'notes/plan.md', name: 'plan.md', kind: 'document', category: 'artifact', summary: 'Created' },
  { id: 'src/app.ts', path: 'src/app.ts', name: 'app.ts', kind: 'code', category: 'artifact', summary: 'Changed' },
];

/** Mirrors how ChatsPage wires the Artifacts tab, the companion toolbar, and the document pane. */
function Harness() {
  const { api } = createMemoryDocumentApi();
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [view, setView] = useState<CompanionView>('chat');
  const [folded, setFolded] = useState(true);
  const companionDocument = useCompanionDocument('conversation-1');
  useCompanionDocumentRequests((document) => {
    companionDocument.open(document);
    setView('document');
    setFolded(false);
  });
  const effectiveView = view === 'document' && !companionDocument.document ? 'chat' : view;
  const hide = () => {
    setFolded(true);
    if (effectiveView === 'document') companionDocument.close();
  };
  return createElement('div', { 'data-view': effectiveView, 'data-open': String(!folded) },
    createElement(DocumentReaderHostContext.Provider, { value: { ...host, opensDocumentsInCompanion: true } },
      createElement(ArtifactInspector, {
        isNativeShell: false,
        artifacts,
        activeArtifactId,
        onSelectArtifact: setActiveArtifactId,
        emptyMessage: 'No artifacts',
      })),
    createElement(CompanionToolbar, {
      view: effectiveView,
      isOpen: !folded,
      canOpenChat: true,
      hasChat: false,
      hasDocument: Boolean(companionDocument.document),
      onSelect: setView,
      onHide: hide,
    }),
    !folded && effectiveView === 'document' && companionDocument.document
      ? createElement(CompanionDocumentPane, { tabs: companionDocument, host, api, onClose: hide })
      : null,
  );
}

function row(root: ParentNode, name: string) {
  const match = Array.from(root.querySelectorAll('[data-artifact-file-row="true"]')).find((entry) => entry.textContent?.includes(name));
  assert.ok(match, `row ${name}`);
  return match as HTMLElement;
}

async function click(element: Element | null) {
  assert.ok(element);
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('selecting a document artifact opens the reader in the companion pane, and hiding it closes the document', async () => {
  await withJsdomRoot(async (mount) => {
    const root = await mount(createElement(Harness));
    const page = root.querySelector('[data-view]') as HTMLElement;
    assert.equal(root.querySelector('[aria-label="Document"]'), null, 'no Document button until a document is open');

    await click(row(root, 'related-work.md'));
    assert.equal(page.dataset.view, 'document');
    assert.equal(page.dataset.open, 'true');
    const pane = root.querySelector('[aria-label="Document panel"]');
    assert.ok(pane?.querySelector('.app-document-reader'), 'the reader renders in the companion pane');
    assert.ok(pane?.querySelector('.app-document-header'), 'the reader header renders in the pane');
    assert.equal(root.querySelector('[data-artifact-preview-section="true"]'), null, 'no inline document preview');
    assert.equal(row(root, 'related-work.md').getAttribute('aria-current'), 'true', 'the list row stays selected');
    const documentButton = root.querySelector('[aria-label="Document"]');
    assert.equal(documentButton?.getAttribute('aria-pressed'), 'true');

    await click(documentButton);
    assert.equal(page.dataset.open, 'false');
    assert.equal(root.querySelector('[aria-label="Document panel"]'), null);
    assert.equal(root.querySelector('[aria-label="Document"]'), null, 'hiding the pane closes the document');
  });
});

test('selecting a code artifact keeps the inline preview', async () => {
  await withJsdomRoot(async (mount) => {
    const root = await mount(createElement(Harness));
    await click(row(root, 'app.ts'));
    const page = root.querySelector('[data-view]') as HTMLElement;
    assert.equal(page.dataset.view, 'chat');
    assert.ok(root.querySelector('[data-artifact-preview-section="true"]'), 'code keeps the inline preview');
    assert.equal(root.querySelector('[aria-label="Document panel"]'), null);
  });
});

function tabs(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLElement>('[aria-label="Open documents"] [role="tab"]'));
}

function tab(root: ParentNode, name: string) {
  const match = tabs(root).find((entry) => entry.textContent === name);
  assert.ok(match, `tab ${name}`);
  return match;
}

function selectedTab(root: ParentNode) {
  return tabs(root).filter((entry) => entry.getAttribute('aria-selected') === 'true').map((entry) => entry.textContent);
}

/** The panel a tab controls; inactive panels stay mounted and hidden. */
function panel(root: ParentNode, name: string) {
  const match = globalThis.document.getElementById(tab(root, name).getAttribute('aria-controls') ?? '');
  assert.ok(match && root.contains(match), `panel ${name}`);
  return match;
}

async function openDocument(name: string) {
  await act(async () => {
    assert.equal(openArtifactInCompanion({ id: `notes/${name}`, path: `notes/${name}`, name, kind: 'document', category: 'artifact', summary: 'Created' }), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function key(element: HTMLElement, name: string) {
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('open documents show as tabs, and switching tabs keeps every reader mounted', async () => {
  await withJsdomRoot(async (mount) => {
    const root = await mount(createElement(Harness));
    const page = root.querySelector('[data-view]') as HTMLElement;
    await click(row(root, 'related-work.md'));
    await click(row(root, 'plan.md'));

    assert.deepEqual(tabs(root).map((entry) => entry.textContent), ['related-work.md', 'plan.md']);
    assert.deepEqual(selectedTab(root), ['plan.md'], 'the document opened last is active');
    assert.equal(root.querySelectorAll('.app-document-reader').length, 2, 'each open document has its reader');
    assert.equal(panel(root, 'related-work.md').hidden, true);
    assert.equal(panel(root, 'plan.md').hidden, false);
    const planReader = panel(root, 'plan.md').querySelector('.app-document-reader');

    await click(tab(root, 'related-work.md'));
    assert.deepEqual(selectedTab(root), ['related-work.md']);
    assert.equal(panel(root, 'related-work.md').hidden, false);
    assert.equal(panel(root, 'plan.md').hidden, true);
    assert.equal(panel(root, 'plan.md').querySelector('.app-document-reader'), planReader, 'the inactive reader stays mounted');
    assert.equal(root.querySelectorAll('.app-document-reader').length, 2);

    await openDocument('related-work.md');
    assert.equal(tabs(root).length, 2, 'reopening an open document adds no tab');
    assert.deepEqual(selectedTab(root), ['related-work.md']);

    await click(root.querySelector('[aria-label="Close related-work.md"]'));
    assert.deepEqual(tabs(root).map((entry) => entry.textContent), ['plan.md']);
    assert.deepEqual(selectedTab(root), ['plan.md'], 'closing the active tab activates its neighbor');
    assert.equal(root.querySelectorAll('.app-document-reader').length, 1, 'the closed reader unmounts');
    assert.equal(panel(root, 'plan.md').querySelector('.app-document-reader'), planReader);
    assert.equal(page.dataset.open, 'true');

    await click(root.querySelector('[aria-label="Close plan.md"]'));
    assert.equal(page.dataset.open, 'false', 'closing the last tab closes the pane');
    assert.equal(root.querySelector('[aria-label="Document panel"]'), null);
    assert.equal(root.querySelector('[aria-label="Document"]'), null);
  });
});

test('closing the active tab prefers its right neighbor, and the keyboard and a middle click work the strip', async () => {
  await withJsdomRoot(async (mount) => {
    const root = await mount(createElement(Harness));
    for (const name of ['a.md', 'b.html', 'c.md', 'd.md']) await openDocument(name);
    await click(tab(root, 'b.html'));
    await click(root.querySelector('[aria-label="Close b.html"]'));
    assert.deepEqual(selectedTab(root), ['c.md'], 'the right neighbor takes over');

    await act(async () => { tab(root, 'c.md').focus(); });
    await key(tab(root, 'c.md'), 'ArrowRight');
    assert.equal(globalThis.document.activeElement, tab(root, 'd.md'), 'arrow keys move focus');
    assert.deepEqual(selectedTab(root), ['c.md'], 'moving focus does not activate');
    await key(tab(root, 'd.md'), 'Enter');
    assert.deepEqual(selectedTab(root), ['d.md']);
    await key(tab(root, 'd.md'), 'Delete');
    assert.deepEqual(tabs(root).map((entry) => entry.textContent), ['a.md', 'c.md']);
    assert.deepEqual(selectedTab(root), ['c.md'], 'the last tab falls back to its left neighbor');

    await act(async () => {
      tab(root, 'a.md').dispatchEvent(new window.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(tabs(root).map((entry) => entry.textContent), ['c.md'], 'a middle click closes a tab');
  });
});

test('a thirteenth document replaces the least recently active tab', async () => {
  await withJsdomRoot(async (mount) => {
    const root = await mount(createElement(Harness));
    for (let index = 1; index <= 12; index += 1) await openDocument(`doc-${index}.md`);
    assert.equal(tabs(root).length, 12);
    await click(tab(root, 'doc-1.md'));

    await openDocument('doc-13.md');
    const names = tabs(root).map((entry) => entry.textContent);
    assert.equal(names.length, 12, 'the strip holds twelve tabs');
    assert.equal(names.includes('doc-2.md'), false, 'the least recently active tab closes');
    assert.equal(names.includes('doc-1.md'), true, 'a tab used since stays');
    assert.deepEqual(selectedTab(root), ['doc-13.md']);
    assert.equal(root.querySelectorAll('.app-document-reader').length, 12);
  });
});

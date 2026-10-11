import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, useState } from 'react';

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
      ? createElement(CompanionDocumentPane, { document: companionDocument.document, host, api, onClose: hide })
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
    assert.match(pane?.querySelector('.app-document-file-name')?.textContent ?? '', /related-work\.md/);
    assert.equal(root.querySelector('[data-artifact-preview-section="true"]'), null, 'no inline document preview');
    assert.equal(row(root, 'related-work.md').className.includes('bg-white/[0.05]'), true, 'the list row stays selected');
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

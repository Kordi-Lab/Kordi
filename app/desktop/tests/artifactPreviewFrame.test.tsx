import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { renderArtifactPreview } from '../src/pages/ArtifactInspector';
import { ARTIFACT_PREVIEW_SANDBOX, ARTIFACT_PREVIEW_SCHEME, ArtifactPreviewFrame } from '../src/pages/artifactPreviewFrame';

type NativeCall = { command: string; args: Record<string, unknown> };

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert(predicate(), message);
}

async function nativeFixture(openDocument: (source: string) => Promise<string>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const replacements = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const calls: NativeCall[] = [];
  Object.assign(dom.window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        // Native IPC completes outside React's render/act queue.
        await new Promise(resolve => setTimeout(resolve, 5));
        calls.push({ command, args });
        if (command === 'desktop_artifact_preview_document_open') return openDocument(String(args.source));
        if (command === 'desktop_artifact_preview_document_close') return null;
        throw Error(`Unexpected command: ${command}`);
      },
      convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`,
    },
  });
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  return {
    calls,
    host,
    frame: () => host.querySelector('iframe'),
    async render(content: React.ReactNode) { await act(async () => root.render(content)); },
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

test('desktop previews load from the preview scheme instead of inheriting the app policy', async () => {
  let opened = 0;
  const view = await nativeFixture(async () => `${String(++opened).padStart(32, '0')}`);
  try {
    const source = '<script src="https://cdn.example.test/chart.js"></script><script>render()</script>';
    await view.render(<ArtifactPreviewFrame title="chart.html preview" source={source} className="h-10" />);
    assert.equal(view.frame()?.getAttribute('data-artifact-preview-state'), 'loading');
    await waitFor(() => view.frame()?.getAttribute('data-artifact-preview-state') === 'ready', 'the preview document must load');

    const frame = view.frame()!;
    assert.equal(frame.getAttribute('src'), `${ARTIFACT_PREVIEW_SCHEME}://localhost/${'1'.padStart(32, '0')}`);
    assert.equal(frame.hasAttribute('srcdoc'), false, 'srcdoc documents inherit the app policy');
    assert.equal(frame.getAttribute('sandbox'), ARTIFACT_PREVIEW_SANDBOX);
    assert.doesNotMatch(frame.getAttribute('sandbox') ?? '', /allow-same-origin|allow-top-navigation/);
    assert.deepEqual(view.calls, [{ command: 'desktop_artifact_preview_document_open', args: { source } }]);

    await view.render(<ArtifactPreviewFrame title="chart.html preview" source="<p>updated</p>" className="h-10" />);
    await waitFor(() => view.frame()?.getAttribute('src')?.endsWith('2'.padStart(32, '0')) === true, 'the updated document must load');
    assert.deepEqual(
      view.calls.filter(call => call.command === 'desktop_artifact_preview_document_close').map(call => call.args.token),
      ['1'.padStart(32, '0')],
      'replaced documents are released',
    );

    await view.render(null);
    await waitFor(() => view.calls.filter(call => call.command === 'desktop_artifact_preview_document_close').length === 2, 'unmounted previews are released');
    assert.equal(view.calls.at(-1)?.args.token, '2'.padStart(32, '0'));
  } finally {
    await view.close();
  }
});

test('desktop previews report documents the app cannot show', async () => {
  const view = await nativeFixture(async () => { throw Error('This artifact is too large to preview here.'); });
  try {
    await view.render(<ArtifactPreviewFrame title="large.html preview" source="<p>large</p>" />);
    await waitFor(() => view.host.querySelector('[data-artifact-preview-state="error"]') !== null, 'the error must be shown');
    assert.equal(view.frame(), null);
    assert.match(view.host.textContent ?? '', /too large to preview/);
  } finally {
    await view.close();
  }
});

test('html artifacts outside the desktop app keep a sandboxed inline frame', () => {
  const markup = renderToStaticMarkup(<div>{renderArtifactPreview({
    path: 'content/page.html',
    lines: [{ number: 1, text: '<h1>Page</h1>' }],
    truncated: false,
  })}</div>);
  assert.match(markup, /srcdoc=/i);
  assert.match(markup, new RegExp(`sandbox="${ARTIFACT_PREVIEW_SANDBOX}"`));
  assert.doesNotMatch(markup, /allow-same-origin/);
});

test('the preview scheme matches the native protocol', () => {
  const nativeSource = readFileSync(
    new URL('../src-tauri/src/chat/artifacts/preview_document.rs', import.meta.url),
    'utf8',
  );
  assert.ok(
    nativeSource.includes(`pub const ARTIFACT_PREVIEW_SCHEME: &str = "${ARTIFACT_PREVIEW_SCHEME}";`),
    'desktop and native copies of the preview scheme must stay identical',
  );
  assert.ok(
    nativeSource.includes(`"sandbox ${ARTIFACT_PREVIEW_SANDBOX}"`),
    'the preview policy sandbox must match the inspector frame sandbox',
  );
});

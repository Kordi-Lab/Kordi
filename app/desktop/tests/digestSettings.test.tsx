import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { digestClient } from '../src/features/digest/client';
import DigestPage from '../src/features/digest/DigestPage';
import type { DigestResponse, DigestSettings } from '../src/features/digest/types';

test('digest settings choose the model and thinking level, and rebuild the whole digest', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  const response: DigestResponse = { accountId: 'viewer', status: 'ready', revision: 1, updatedAt: new Date().toISOString(), partial: false, feedback: [], sources: [], snapshot: { claims: [], commitments: [], suggestions: [], calendarCandidates: [] } };
  const saved: Pick<DigestSettings, 'model' | 'thinking'>[] = [];
  const refreshes: boolean[] = [];
  digestClient.read = async () => structuredClone(response);
  digestClient.calendar = async () => ({ events: [] });
  digestClient.settings = async () => ({ model: 'fast', thinking: 'low', provider: 'anthropic', fastModel: 'claude-haiku-4-5', chatModel: 'claude-opus-4-8' });
  digestClient.saveSettings = async (_, settings) => { saved.push(settings); };
  digestClient.refresh = async (_, full = false) => { refreshes.push(full); };
  const host = dom.window.document.getElementById('root')!, root = createRoot(host);
  const choose = async (label: string, value: string) => {
    const select = [...host.querySelectorAll('label')].find(item => item.textContent?.startsWith(label))!.querySelector('select')!;
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId: 'settings-viewer' })));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Digest settings"]')!.click());
    const dialog = host.querySelector('dialog[aria-label="Digest settings"]')!;
    assert.ok(dialog, 'the settings sheet opens');
    const options = [...dialog.querySelectorAll('option')].map(option => option.textContent);
    assert.deepEqual(options, ['Fast (claude-haiku-4-5)', 'Same as chat (claude-opus-4-8)', 'Off', 'Low', 'Medium', 'High']);
    assert.equal(dialog.querySelectorAll('p').length, 0, 'no helper text');
    await choose('Model', 'chat');
    await choose('Thinking', 'medium');
    assert.deepEqual(saved, [{ model: 'chat', thinking: 'low' }, { model: 'chat', thinking: 'medium' }]);
    const rebuild = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Rebuild digest')!;
    await act(async () => rebuild.click());
    assert.deepEqual(refreshes, [true]);
    assert.equal(host.querySelector('dialog[aria-label="Digest settings"]'), null, 'the sheet closes after a rebuild');
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original); Object.assign(globalThis, previous); dom.window.close();
  }
});

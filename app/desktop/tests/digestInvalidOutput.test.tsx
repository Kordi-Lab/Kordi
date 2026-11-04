import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import DigestPage from '../src/features/digest/DigestPage';
import CompanionOverview from '../src/pages/chatsPage.companionOverview';
import { digestClient } from '../src/features/digest/client';
import type { DigestResponse } from '../src/features/digest/types';

// Synthetic rendering of the error code recorded in #2186; no provider reply is fabricated.
for (const companion of [false, true]) {
  for (const withSnapshot of [false, true]) {
    test(`invalid output offers a bounded full rebuild (${companion ? 'panel' : 'page'}, ${withSnapshot ? 'saved' : 'first'} digest)`, async () => {
      const dom = new JSDOM('<div id="root"></div>');
      const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
      const original = { ...digestClient };
      const accountId = `invalid-output-${companion}-${withSnapshot}`;
      const digest: DigestResponse = {
        accountId, status: 'error', errorCode: 'invalid_output', revision: 1,
        updatedAt: '2026-11-01T12:00:00Z', partial: false, feedback: [], sources: [],
        snapshot: withSnapshot ? {
          claims: [{ id: 'saved', title: 'Previously verified brief', text: 'Retained content.', sourceIds: [], kind: 'progress' }],
          commitments: [], suggestions: [], calendarCandidates: [],
        } : null,
      };
      const requests: [string, boolean][] = [];
      let release!: () => void;
      let settingsWrites = 0;
      digestClient.read = async () => structuredClone(digest);
      digestClient.calendar = async () => ({ events: [] });
      digestClient.refresh = async (account, full = false) => {
        requests.push([account, full]);
        await new Promise<void>(resolve => { release = resolve; });
      };
      digestClient.saveSettings = async () => { settingsWrites++; };
      const host = document.getElementById('root')!, root = createRoot(host);
      const recovery = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Rebuild digest');
      try {
        await act(async () => root.render(companion
          ? createElement(CompanionOverview, { accountId, view: 'digest', onClose: () => {} })
          : createElement(DigestPage, { accountId })));
        assert.match(host.textContent!, /The generated digest could not be verified/);
        assert.equal(requests.length, 0, 'rendering an error must not invoke the model');
        assert.ok(recovery(), 'the error must offer the full-rebuild recovery directly');
        if (withSnapshot) assert.match(host.textContent!, /Previously verified brief/);
        await act(async () => recovery()!.click());
        assert.deepEqual(requests, [[accountId, true]], 'one action requests one full rebuild');
        assert.equal(recovery()!.disabled, true, 'prevent repeated submissions while the request is pending');
        await act(async () => recovery()!.click());
        assert.equal(requests.length, 1);
        await act(async () => release());
        assert.equal(requests.length, 1, 'a repeated invalid result must not trigger an automatic retry loop');
        assert.equal(settingsWrites, 0, 'recovery must preserve the selected model and thinking level');
        assert.equal(recovery()!.disabled, false);
        if (withSnapshot) assert.match(host.textContent!, /Previously verified brief/);
      } finally {
        await act(async () => root.unmount());
        Object.assign(digestClient, original); Object.assign(globalThis, previous); dom.window.close();
      }
    });
  }
}

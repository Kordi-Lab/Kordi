import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { digestClient } from '../src/features/digest/client';
import DigestPage from '../src/features/digest/DigestPage';
import type { DigestResponse } from '../src/features/digest/types';

function rejected(accountId: string, errorProvider: string | null, withBrief: boolean): DigestResponse {
  return {
    accountId, status: 'error', errorCode: 'provider_auth_rejected', errorProvider,
    revision: 1, updatedAt: '2026-09-30T16:57:03Z', partial: false, feedback: [],
    sources: [],
    snapshot: withBrief ? { claims: [], commitments: [], suggestions: [], calendarCandidates: [] } : null,
  };
}

async function headerFor(digest: DigestResponse) {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const original = { ...digestClient };
  digestClient.read = async () => digest;
  digestClient.calendar = async () => ({ events: [] });
  const host = document.getElementById('root')!, root = createRoot(host);
  try {
    await act(async () => root.render(createElement(DigestPage, { accountId: digest.accountId, onOpenProviderSettings: () => {} })));
    return host.querySelector('.digest-status')!.textContent!;
  } finally {
    await act(async () => root.unmount());
    Object.assign(digestClient, original); Object.assign(globalThis, previous); dom.window.close();
  }
}

test('a refused sign-in names the account to reconnect', async () => {
  assert.match(await headerFor(rejected('reconnect-brief', 'anthropic', true)), /Updated .* · Reconnect Claude · Open settings/);
  assert.match(await headerFor(rejected('reconnect-empty', 'openai-codex', false)), /^Reconnect OpenAI · Open settings$/);
  assert.match(await headerFor(rejected('reconnect-unknown', null, true)), /Provider sign-in didn't work · Open settings/);
});

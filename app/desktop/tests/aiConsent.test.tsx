import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { createAiConsentClient, type AiConsentClient, type AiConsentStatus } from '../src/features/aiConsent/aiConsentClient';
import { AiConsentHost } from '../src/features/aiConsent/AiConsentHost';
import { chatSendNeedsAiConsent, draftMentionsAgent } from '../src/features/aiConsent/aiConsentSendGate';
import { AiConsentSettingsPanel } from '../src/features/aiConsent/AiConsentSettingsPanel';
import {
  AI_CONSENT_SAVE_ERROR,
  AI_CONSENT_USER_ACTION_WINDOW_MS,
  applyAiConsent,
  getAiConsentState,
  handleAiConsentRequired,
  noteAiConsentUserInput,
  requireAiConsent,
  resetAiConsent,
  saveAiConsent,
} from '../src/features/aiConsent/aiConsentStore';
import type { CloudAccount } from '../src/features/cloud/authClient';
import { buildCloudAuthError } from '../src/features/cloud/cloudAuthError';

afterEach(() => resetAiConsent());

function recordingClient(options: { fail?: boolean; initial?: AiConsentStatus } = {}) {
  const puts: AiConsentStatus[] = [];
  const client: AiConsentClient = {
    async get() { return { status: options.initial ?? 'unset', decidedAt: null }; },
    async put(status) {
      puts.push(status);
      if (options.fail) throw new Error('offline');
      return { status, decidedAt: '2026-11-05T00:00:00Z' };
    },
  };
  return { client, puts };
}

test('agent actions go ahead only after consent; unknown servers keep working', () => {
  assert.equal(requireAiConsent(), true, 'no account or older server');
  applyAiConsent('acct_1', 'allowed');
  assert.equal(requireAiConsent(), true);
  assert.equal(getAiConsentState().prompt, null);

  applyAiConsent('acct_1', 'unset');
  assert.equal(requireAiConsent(), false);
  assert.equal(getAiConsentState().prompt, 'consent');

  applyAiConsent('acct_1', 'declined');
  assert.equal(getAiConsentState().prompt, null, 'a decision answers the consent prompt');
  assert.equal(requireAiConsent(), false);
  assert.equal(getAiConsentState().prompt, 'off');
  applyAiConsent('acct_1', 'allowed');
  assert.equal(getAiConsentState().prompt, null, 'allowing elsewhere closes "AI models are off"');
});

test('switching accounts clears the previous account consent', () => {
  applyAiConsent('acct_1', 'declined');
  requireAiConsent();
  applyAiConsent('acct_2', null);
  assert.deepEqual(getAiConsentState(), { accountId: 'acct_2', status: null, prompt: null, saving: false, error: null });
});

test('a server ai_consent_required refusal marks the account declined and prompts only after a person acted', () => {
  applyAiConsent('acct_1', 'allowed');
  noteAiConsentUserInput(0);
  handleAiConsentRequired(AI_CONSENT_USER_ACTION_WINDOW_MS + 1);
  assert.equal(getAiConsentState().status, 'declined');
  assert.equal(getAiConsentState().prompt, null, 'background refusals stay quiet');

  applyAiConsent('acct_1', 'allowed');
  noteAiConsentUserInput();
  const error = buildCloudAuthError(403, { error: { code: 'ai_consent_required', message: 'AI models are off.' } }, 'Could not send.');
  assert.equal(error.code, 'ai_consent_required');
  assert.equal(error.status, 403);
  assert.equal(getAiConsentState().status, 'declined');
  assert.equal(getAiConsentState().prompt, 'off');
});

test('saving a choice updates the status and keeps the prompt open on failure', async () => {
  applyAiConsent('acct_1', 'unset');
  requireAiConsent();
  const failing = recordingClient({ fail: true });
  assert.equal(await saveAiConsent('allowed', failing.client), false);
  assert.equal(getAiConsentState().prompt, 'consent');
  assert.equal(getAiConsentState().error, AI_CONSENT_SAVE_ERROR);

  const working = recordingClient();
  assert.equal(await saveAiConsent('declined', working.client), true);
  assert.deepEqual(working.puts, ['declined']);
  assert.equal(getAiConsentState().status, 'declined');
  assert.equal(getAiConsentState().prompt, null);
  assert.equal(getAiConsentState().error, null);
});

test('the consent client calls the account route with the session token', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const client = createAiConsentClient({
    request: async <T,>(path: string, init: RequestInit) => {
      calls.push({ path, init });
      return { status: init.method === 'PUT' ? JSON.parse(String(init.body)).status : 'unset', decidedAt: null } as T;
    },
  }, async () => ({ token: 'tok' }));
  assert.deepEqual(await client.get(), { status: 'unset', decidedAt: null });
  assert.deepEqual(await client.put('allowed'), { status: 'allowed', decidedAt: null });
  assert.equal(calls[0].path, '/v1/cloud/account/ai-consent');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, 'Bearer tok');
  assert.equal(calls[1].init.body, JSON.stringify({ status: 'allowed' }));
  await assert.rejects(createAiConsentClient({ request: async <T,>() => ({ status: 'maybe' }) as T }, async () => ({ token: 'tok' })).get());
});

test('chat sends that reach an AI model need consent; people-to-people sends do not', () => {
  const options = [
    { value: 'Research', targetKind: 'agent' as const },
    { value: 'Priya', targetKind: 'person' as const },
  ];
  assert.equal(chatSendNeedsAiConsent({ paneKind: 'agent', draft: 'hi', mentionOptions: [] }), true);
  assert.equal(chatSendNeedsAiConsent({ paneKind: 'human', draft: 'hi @Priya', mentionOptions: options }), false);
  assert.equal(chatSendNeedsAiConsent({ paneKind: 'human', draft: 'ask @research, please', mentionOptions: options }), true);
  assert.equal(chatSendNeedsAiConsent({ paneKind: 'human', draft: 'hello', mentionOptions: options, asksAgent: true }), true);
  assert.equal(draftMentionsAgent('@kordi summarize this', []), true);
  assert.equal(draftMentionsAgent('@Researcher hi', options), false, 'a longer name is not the agent');
  assert.equal(draftMentionsAgent('mail me at a@kordi.ai', []), false);
});

async function withDom(run: () => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'http://127.0.0.1/' });
  const values = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    await run();
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function account(status?: AiConsentStatus): CloudAccount {
  return {
    accountId: 'acct_1', displayName: 'Taylor', primaryEmail: 'taylor@example.test', avatarUrl: null,
    avatar: { style: 'boring-marble-v1', seed: 'seed' } as CloudAccount['avatar'], nodeId: null, passwordSet: true,
    ...(status ? { aiConsent: { status, decidedAt: null } } : {}),
  };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  assert.ok(found, `button ${label}`);
  return found as HTMLButtonElement;
}

test('after sign-in an undecided account sees the consent prompt once and Allow saves it', async () => {
  await withDom(async () => {
    const { client, puts } = recordingClient();
    const root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(createElement(AiConsentHost, { account: account('unset'), client })));
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /Kordi uses AI models/);
    assert.match(dialog.textContent ?? '', /send the messages, files and calendar details they work on to AI providers such as OpenAI and Google\./);
    assert.equal(dialog.querySelector('a')?.getAttribute('href'), 'https://kordi.ai/privacy');
    assert.ok(button("Don't allow"));
    await act(async () => { button('Allow').click(); });
    assert.deepEqual(puts, ['allowed']);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => root.unmount());
  });
});

test('a declined account sees "AI models are off" on an agent action and can allow from it', async () => {
  await withDom(async () => {
    const { client, puts } = recordingClient();
    const root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(createElement(AiConsentHost, { account: account('declined'), client })));
    assert.equal(document.querySelector('[role="dialog"]'), null, 'no prompt on sign-in once decided');
    await act(async () => { assert.equal(requireAiConsent(), false); });
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /AI models are off/);
    assert.match(dialog.textContent ?? '', /Allow in Settings › Privacy to use agents\./);
    await act(async () => { button('Cancel').click(); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => { requireAiConsent(); });
    await act(async () => { button('Allow').click(); });
    assert.deepEqual(puts, ['allowed']);
    assert.equal(getAiConsentState().status, 'allowed');
    await act(async () => root.unmount());
  });
});

test('an account response without consent falls back to the consent route', async () => {
  await withDom(async () => {
    const { client } = recordingClient({ initial: 'declined' });
    const root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(createElement(AiConsentHost, { account: account(), client })));
    assert.equal(getAiConsentState().status, 'declined');
    await act(async () => root.unmount());
  });
});

test('Settings › Privacy switches sharing and links the legal pages', async () => {
  await withDom(async () => {
    const { client, puts } = recordingClient();
    applyAiConsent('acct_1', 'allowed');
    const root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(createElement(AiConsentSettingsPanel, { client })));
    const text = document.body.textContent ?? '';
    assert.match(text, /Share with AI models/);
    assert.match(text, /OpenAI and Google process what agents work on\./);
    assert.match(text, /Privacy policy/);
    assert.match(text, /Terms of service/);
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    await act(async () => { toggle.click(); });
    assert.deepEqual(puts, ['declined']);
    assert.equal(toggle.getAttribute('aria-checked'), 'false');

    applyAiConsent('acct_2', null);
    await act(async () => {});
    assert.equal(document.querySelector('[role="switch"]'), null, 'servers without AI consent show only the links');
    await act(async () => root.unmount());
  });
});

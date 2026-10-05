import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { companionComposerAuthPresentation, companionComposerProviderOptions, useCompanionComposerRuntime } from '../src/features/chat/useCompanionComposerRuntime';
import { resolveComposerModelSelection } from '../src/kordi-app/components/composerModelSelection';
import type { ComposerAuthOption, ComposerModelOption } from '../src/kordi-app/components';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  return {
    dom,
    restore() {
      previous.forEach((descriptor, key) => {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      });
      dom.window.close();
    },
  };
}

const modelOptions: ComposerModelOption[] = [
  { value: 'openai/gpt-5.4-mini', label: 'gpt-5.4-mini', provider: 'openai' },
  { value: 'openai/gpt-5.4', label: 'gpt-5.4', provider: 'openai' },
];

test('the panel presents its routed account instead of the account active in the main chat', () => {
  const accounts: ComposerAuthOption[] = [
    { providerId: 'openai-codex', providerLabel: 'ChatGPT', methodLabel: 'Saved account', value: 'cloud-login:main', label: 'Main', active: true },
    { providerId: 'openai-codex', providerLabel: 'ChatGPT', methodLabel: 'Saved account', value: 'cloud-login:panel', label: 'Panel', active: false },
  ];
  const presentation = companionComposerAuthPresentation({ mode: 'agent', model: 'openai/gpt-5.4', thinking: 'off' }, modelOptions, accounts,
    { model: 'openai/gpt-5.4', authProvider: 'openai-codex', authChoice: 'cloud-login:panel' });
  assert.equal(presentation.label, 'ChatGPT · Panel');
  assert.deepEqual(presentation.options.filter(option => option.active).map(option => option.value), ['cloud-login:panel']);
  assert.equal(accounts[0].active, true, 'Panel presentation must not mutate shared options');
  const providers = accounts.map(option => ({ value: `${option.providerId}::${option.value}`, providerId: option.providerId,
    label: option.label, selectionLabel: `ChatGPT · ${option.label}`, active: option.active }));
  const route = { model: 'openai/gpt-5.4', authProvider: 'openai-codex', authChoice: 'cloud-login:panel' };
  const selection = resolveComposerModelSelection({ selection: { mode: 'agent', model: route.model, thinking: 'off' }, modelOptions,
    providerOptions: companionComposerProviderOptions(providers, route) });
  assert.equal(selection.selectedProviderOption?.selectionLabel, 'ChatGPT · Panel');
  const missing = companionComposerProviderOptions(providers, { ...route, authChoice: 'cloud-login:missing' });
  assert.equal(missing.find(option => option.active)?.selectionLabel, 'Account unavailable');
  assert.equal(missing.find(option => option.active)?.disabled, true);
});

const authOptions: ComposerAuthOption[] = [
  {
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
    methodLabel: 'API key',
    value: 'anthropic::key',
    label: 'Anthropic key',
    active: true,
  },
  {
    providerId: 'openai-codex',
    providerLabel: 'OpenAI',
    methodLabel: 'OAuth',
    value: 'openai-codex::chatgpt',
    label: 'ChatGPT Plus',
    active: true,
  },
];

test('companion controls hydrate model, thinking, and auth from the exact side runtime', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let latest: ReturnType<typeof useCompanionComposerRuntime> | null = null;
  const requestedSessionIds: string[] = [];
  const loadSessionDetail = async (sessionId: string) => {
    requestedSessionIds.push(sessionId);
    return {
      id: sessionId,
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: 'high',
    };
  };

  function Harness() {
    latest = useCompanionComposerRuntime({
      enabled: true,
      isNativeShell: true,
      sessionId: 'session:self-agent:side',
      fallbackMode: 'agent',
      modelOptions,
      authOptions,
      loadSessionDetail,
    });
    return null;
  }

  try {
    await act(async () => {
      root?.render(<Harness />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(requestedSessionIds, ['session:self-agent:side']);
    assert.deepEqual(latest?.selection, {
      mode: 'agent',
      model: 'openai/gpt-5.4',
      thinking: 'high',
    });
    assert.equal(latest?.authLabel, 'OpenAI · ChatGPT Plus');
    assert.equal(latest?.authOptions[0]?.providerId, 'openai-codex');
    assert.equal(latest?.configTarget?.sessionId, 'session:self-agent:side');
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

test('companion hydration failures expose a retry that can recover the exact runtime', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  let latest: ReturnType<typeof useCompanionComposerRuntime> | null = null;
  let attempts = 0;
  const loadSessionDetail = async (sessionId: string) => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary read failure');
    return {
      id: sessionId,
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: 'high',
    };
  };

  function Harness() {
    latest = useCompanionComposerRuntime({
      enabled: true,
      isNativeShell: true,
      sessionId: 'session:self-agent:retry',
      fallbackMode: 'agent',
      modelOptions,
      authOptions,
      loadSessionDetail,
    });
    return null;
  }

  try {
    await act(async () => {
      root?.render(<Harness />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(latest?.isLoading, false);
    assert.equal(latest?.loadError, 'temporary read failure');
    assert.equal(typeof latest?.retry, 'function');

    await act(async () => {
      latest?.retry();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(attempts, 2);
    assert.equal(latest?.loadError, null);
    assert.equal(latest?.selection?.model, 'openai/gpt-5.4');
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

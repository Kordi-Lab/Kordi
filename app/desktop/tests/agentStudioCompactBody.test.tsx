import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AgentStudioCompactBody } from '../src/kordi-app/agents/AgentStudioCompactBody';

test('compact Factory switcher shows Chat and Blueprint tabs and selects the body pane', async () => {
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
  const previous = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.entries(replacements).forEach(([key, value]) => {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  });
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | null = createRoot(host);
  try {
    await act(async () => root?.render(
      <AgentStudioCompactBody>
        <section className="app-agent-studio-conversation" />
        <section className="app-agent-studio-workspace" />
      </AgentStudioCompactBody>,
    ));
    const switcher = host.querySelector('.app-agent-studio-compact-switcher[role="tablist"]');
    const tabs = Array.from(switcher?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const body = host.querySelector('.app-agent-studio-body');
    assert.deepEqual(tabs.map((tab) => tab.textContent), ['Chat', 'Blueprint']);
    assert.equal(switcher?.nextElementSibling, body);
    assert.equal(body?.getAttribute('data-compact-pane'), 'chat');
    assert.equal(tabs[0]?.getAttribute('aria-selected'), 'true');
    assert.equal(body?.querySelectorAll('section').length, 2);

    await act(async () => tabs[1]?.click());
    assert.equal(body?.getAttribute('data-compact-pane'), 'workspace');
    assert.equal(tabs[1]?.getAttribute('aria-selected'), 'true');
    assert.equal(tabs[1]?.classList.contains('is-active'), true);
    assert.equal(tabs[0]?.getAttribute('aria-selected'), 'false');

    await act(async () => tabs[0]?.click());
    assert.equal(body?.getAttribute('data-compact-pane'), 'chat');

    // Editing an existing agent opens on the Blueprint.
    await act(async () => root?.render(
      <AgentStudioCompactBody initialPane="workspace">
        <section className="app-agent-studio-conversation" />
        <section className="app-agent-studio-workspace" />
      </AgentStudioCompactBody>,
    ));
    assert.equal(host.querySelector('.app-agent-studio-body')?.getAttribute('data-compact-pane'), 'workspace');
  } finally {
    await act(async () => root?.unmount());
    root = null;
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
    dom.window.close();
  }
});

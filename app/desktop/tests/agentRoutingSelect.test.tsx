import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AgentRoutingSelect } from '../src/kordi-app/agents/AgentDetailPane';

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

test('agent routing listbox supports focus, arrows, Escape, and focus restoration', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const selected: string[] = [];
  let root: Root | null = createRoot(host);

  try {
    await act(async () => {
      root?.render(
        <AgentRoutingSelect
          label="Default route"
          value="one"
          options={[
            { value: 'one', label: 'Model one' },
            { value: 'two', label: 'Model two' },
          ]}
          onChange={(option) => selected.push(option.value)}
        />,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    assert.ok(trigger);
    trigger.focus();
    await act(async () => trigger.click());

    const listbox = host.querySelector<HTMLElement>('[role="listbox"]');
    const options = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
    assert.ok(listbox?.getAttribute('aria-labelledby'));
    assert.equal(document.activeElement, options[0]);

    options[0]?.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }));
    assert.equal(document.activeElement, options[1]);

    await act(async () => {
      document.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(host.querySelector('[role="listbox"]'), null);
    assert.equal(document.activeElement, trigger);

    await act(async () => trigger.click());
    const secondOption = host.querySelectorAll<HTMLButtonElement>('[role="option"]')[1];
    await act(async () => secondOption?.click());
    assert.deepEqual(selected, ['two']);
    assert.equal(document.activeElement, trigger);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    host.remove();
    installed.restore();
  }
});

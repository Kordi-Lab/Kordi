import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act, createRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { parseBirdAvatarSeed } from '../src/features/cloud/birdAvatars';
import { cloudAgentAvatarControls } from '../src/kordi-app/agents/model';
import { AgentAvatarPicker } from '../src/kordi-app/components/AgentAvatarPicker';
import { EditableIdentityAvatar } from '../src/kordi-app/components/EditableIdentityAvatar';
import type { Agent } from '../src/kordi-app/types';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://kordi.ai/' });
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

function Harness({ picks, uploads }: { picks: string[]; uploads: string[] }) {
  const [open, setOpen] = useState(true);
  const anchorRef = createRef<HTMLButtonElement>();
  return (
    <>
      <button ref={anchorRef} type="button" data-testid="anchor">Choose avatar</button>
      <AgentAvatarPicker
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        currentSeed="bird-sparrow-color-paper"
        onPick={(seed) => picks.push(seed)}
        onUpload={() => uploads.push('upload')}
      />
    </>
  );
}

test('agent avatar picker writes structured bird seeds and stays open', async () => {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const picks: string[] = [];
  const uploads: string[] = [];
  let root: Root | null = createRoot(host);

  try {
    await act(async () => root?.render(<Harness picks={picks} uploads={uploads} />));
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Avatar"]');
    assert.ok(dialog());
    assert.equal(dialog()?.querySelectorAll('[data-bird-species]').length, 16);
    assert.equal(dialog()?.querySelectorAll('[data-bird-palette]').length, 8);
    assert.equal(dialog()?.querySelector('[data-bird-species="sparrow"]')?.getAttribute('aria-pressed'), 'true');
    assert.match(
      dialog()?.querySelector('[data-bird-species="owl"] img')?.getAttribute('src') ?? '',
      /\/v1\/avatars\/preview\/kordi-birds\/bird-owl-color-paper\.png$/,
    );

    await act(async () => dialog()?.querySelector<HTMLButtonElement>('[aria-label="Owl"]')?.click());
    assert.deepEqual(picks, ['bird-owl-color-paper']);
    assert.ok(dialog(), 'picking keeps the popover open');

    const ink = Array.from(dialog()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []).find((button) => button.textContent === 'Ink');
    await act(async () => ink?.click());
    assert.equal(picks.at(-1), 'bird-owl-ink-paper');

    await act(async () => dialog()?.querySelector<HTMLButtonElement>('[data-bird-palette="sky"]')?.click());
    assert.equal(picks.at(-1), 'bird-owl-ink-sky');
    assert.match(
      dialog()?.querySelector('[data-bird-species="heron"] img')?.getAttribute('src') ?? '',
      /bird-heron-ink-sky\.png$/,
    );

    const shuffle = Array.from(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent === 'Shuffle');
    await act(async () => shuffle?.click());
    assert.equal(picks.length, 4);
    assert.ok(parseBirdAvatarSeed(picks.at(-1)), picks.at(-1));

    await act(async () => {
      window.dispatchEvent(new installed.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(dialog(), null);
    assert.deepEqual(uploads, []);
  } finally {
    await act(async () => root?.unmount());
    root = null;
    installed.restore();
  }
});

test('agent avatar controls open the picker and save the chosen seed as a regenerate', async () => {
  const updates: unknown[] = [];
  const agent = { id: 'cloud:agent', cloudAgentId: 'agent_1', cloudAgentAvatarVersion: 3, avatarSeed: '7bbaa257' } as Agent;
  const controls = cloudAgentAvatarControls(agent, async (_agent, input) => { updates.push(input); });
  assert.equal(controls.currentSeed, '7bbaa257');
  assert.equal('onGenerate' in controls, false);
  await controls.onPick?.('bird-owl-ink-paper');
  assert.deepEqual(updates, [{ avatarMutation: { action: 'regenerate', seed: 'bird-owl-ink-paper', expectedVersion: 3 } }]);

  const markup = renderToStaticMarkup(
    <EditableIdentityAvatar kind="agent" seed="7bbaa257" name="Researcher" {...controls} />,
  );
  assert.match(markup, /aria-label="Choose avatar"/);
  assert.match(markup, /lucide-bird/);
  assert.doesNotMatch(markup, /lucide-dice-5/);
  assert.match(markup, /aria-label="Upload avatar"/);

  const human = renderToStaticMarkup(
    <EditableIdentityAvatar kind="human" seed="acct_1" onGenerate={() => undefined} onUpload={() => undefined} />,
  );
  assert.match(human, /lucide-dice-5/);
  assert.doesNotMatch(human, /Choose avatar/);
});

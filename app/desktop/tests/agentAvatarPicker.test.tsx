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

async function withPicker(run: (helpers: {
  dom: JSDOM;
  picks: string[];
  uploads: string[];
  dialog: () => HTMLElement | null;
  button: (label: string) => HTMLButtonElement | undefined;
  reopen: () => Promise<void>;
}) => Promise<void>) {
  const installed = installDom();
  const host = document.createElement('div');
  document.body.append(host);
  const picks: string[] = [];
  const uploads: string[] = [];
  let root: Root | null = createRoot(host);
  let renderKey = 0;
  const render = () => act(async () => root?.render(<Harness key={renderKey} picks={picks} uploads={uploads} />));
  try {
    await render();
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Avatar"]');
    const button = (label: string) => Array.from(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((item) => item.textContent === label);
    const reopen = async () => {
      renderKey += 1;
      await render();
    };
    await run({ dom: installed.dom, picks, uploads, dialog, button, reopen });
  } finally {
    await act(async () => root?.unmount());
    root = null;
    installed.restore();
  }
}

test('agent avatar picker keeps tile, tone and colour picks pending until Save', async () => {
  await withPicker(async ({ picks, uploads, dialog, button }) => {
    assert.ok(dialog());
    assert.equal(dialog()?.querySelectorAll('[data-bird-species]').length, 16);
    assert.equal(dialog()?.querySelectorAll('[data-bird-palette]').length, 8);
    assert.equal(dialog()?.querySelector('[data-bird-species="sparrow"]')?.getAttribute('aria-pressed'), 'true');
    assert.match(
      dialog()?.querySelector('[data-bird-species="owl"] img')?.getAttribute('src') ?? '',
      /\/v1\/avatars\/preview\/kordi-birds\/bird-owl-color-paper\.png$/,
    );
    assert.equal(button('Save')?.disabled, true, 'Save is disabled while nothing changed');

    await act(async () => dialog()?.querySelector<HTMLButtonElement>('[aria-label="Owl"]')?.click());
    assert.deepEqual(picks, [], 'clicking a bird does not save');
    assert.equal(dialog()?.querySelector('[data-bird-species="owl"]')?.getAttribute('aria-pressed'), 'true');
    assert.equal(button('Save')?.disabled, false);

    const ink = Array.from(dialog()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []).find((item) => item.textContent === 'Ink');
    await act(async () => ink?.click());
    await act(async () => dialog()?.querySelector<HTMLButtonElement>('[data-bird-palette="sky"]')?.click());
    assert.deepEqual(picks, []);
    assert.match(
      dialog()?.querySelector('[data-bird-species="heron"] img')?.getAttribute('src') ?? '',
      /bird-heron-ink-sky\.png$/,
    );

    await act(async () => dialog()?.querySelector<HTMLButtonElement>('[aria-label="Sparrow"]')?.click());
    await act(async () => ink?.click());
    const color = Array.from(dialog()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []).find((item) => item.textContent === 'Color');
    await act(async () => color?.click());
    await act(async () => dialog()?.querySelector<HTMLButtonElement>('[data-bird-palette="paper"]')?.click());
    assert.equal(button('Save')?.disabled, true, 'returning to the saved bird disables Save again');

    await act(async () => dialog()?.querySelector<HTMLButtonElement>('[aria-label="Owl"]')?.click());
    await act(async () => ink?.click());
    await act(async () => button('Save')?.click());
    assert.deepEqual(picks, ['bird-owl-ink-paper'], 'Save writes the structured seed once');
    assert.equal(dialog(), null, 'Save closes the popover');
    assert.deepEqual(uploads, []);
  });
});

test('agent avatar picker Cancel, Escape and outside clicks discard the pending pick', async () => {
  await withPicker(async ({ dom, picks, dialog, button, reopen }) => {
    await act(async () => dialog()?.querySelector<HTMLButtonElement>('[aria-label="Owl"]')?.click());
    await act(async () => button('Cancel')?.click());
    assert.equal(dialog(), null);
    assert.deepEqual(picks, []);

    await reopen();
    assert.equal(dialog()?.querySelector('[data-bird-species="sparrow"]')?.getAttribute('aria-pressed'), 'true', 'reopening starts from the saved seed');
    await act(async () => dialog()?.querySelector<HTMLButtonElement>('[aria-label="Owl"]')?.click());
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(dialog(), null);
    assert.deepEqual(picks, []);

    await reopen();
    await act(async () => dialog()?.querySelector<HTMLButtonElement>('[aria-label="Owl"]')?.click());
    await act(async () => {
      document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    });
    assert.equal(dialog(), null);
    assert.deepEqual(picks, []);
  });
});

test('agent avatar picker Shuffle changes the pending bird without saving', async () => {
  await withPicker(async ({ picks, dialog, button }) => {
    const selectedImage = () => dialog()?.querySelector('[aria-pressed="true"] img')?.getAttribute('src') ?? '';
    const before = selectedImage();
    for (let attempt = 0; attempt < 50 && button('Save')?.disabled; attempt += 1) {
      await act(async () => button('Shuffle')?.click());
    }
    assert.deepEqual(picks, [], 'Shuffle does not save');
    assert.equal(button('Save')?.disabled, false);
    assert.notEqual(selectedImage(), before);

    const seed = /\/(bird-[a-z]+-[a-z]+-[a-z]+)\.png$/.exec(selectedImage())?.[1];
    await act(async () => button('Save')?.click());
    assert.equal(picks.length, 1);
    assert.ok(parseBirdAvatarSeed(picks[0]), picks[0]);
    assert.equal(picks[0], seed);
  });
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

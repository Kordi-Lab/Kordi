import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  cleanupVirtualTranscriptHarness,
  installVirtualTranscriptHarness,
  render,
  rows,
  transcript,
} from './support/virtualTranscriptHarness';

test.before(async () => {
  await installVirtualTranscriptHarness();
});

test.afterEach(async () => {
  await cleanupVirtualTranscriptHarness();
});

test('light theme own-message highlight overrides the normal bubble fill', () => {
  const style = document.createElement('style');
  style.textContent = [
    readFileSync(new URL('../src/styles/shell-bubbles.css', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/styles/shell-message-actions.css', import.meta.url), 'utf8'),
  ].join('\n');
  document.head.append(style);

  const app = document.createElement('div');
  app.className = 'kordi-app theme-light';
  const highlightedRow = document.createElement('div');
  highlightedRow.className = 'app-transcript-message-highlight';
  const bubble = document.createElement('div');
  bubble.className = 'app-message-bubble app-chat-bubble-user';
  highlightedRow.append(bubble);
  app.append(highlightedRow);
  document.body.append(app);

  try {
    const fill = window.getComputedStyle(bubble).getPropertyValue('--app-message-bubble-fill');
    assert.match(fill, /color-mix\(in oklab/);
    assert.match(fill, /--app-transcript-highlight-accent/);
  } finally {
    style.remove();
    app.remove();
  }
});

test('off-screen navigation commits the route-back highlight before acknowledging the request', async () => {
  let highlightedWhenHandled = false;

  const view = await render(transcript({
    items: rows('cloud-', 0, 1_000),
    sessionKey: 'cloud-group-session',
    navigationRequest: {
      id: 'cloud-120',
      nonce: 1,
      sessionKey: 'cloud-group-session',
    },
    onNavigationHandled: () => {
      const target = document.querySelector<HTMLElement>(
        '[data-transcript-window-item="true"][data-index="120"]',
      );
      highlightedWhenHandled = Boolean(
        target?.classList.contains('app-transcript-message-highlight'),
      );
    },
  }));

  const target = view.host.querySelector<HTMLElement>('[data-message-id="cloud-120"]')
    ?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.ok(target, 'the off-screen source request should be mounted');
  assert.equal(highlightedWhenHandled, true);
  assert.equal(target.classList.contains('app-transcript-message-highlight'), true);
  assert.equal(view.host.querySelectorAll('.app-transcript-message-highlight').length, 1);
});

test('an acknowledged highlight follows the visible row across canonical hydration aliases', async () => {
  const request = {
    id: 'msg:ui:persisted-request',
    nonce: 1,
    sessionKey: 'agent-session',
    lookupIds: ['msg:ui:persisted-request', 'runtime-entry-visible'],
  };
  const runtimeRow = {
    id: 'runtime-entry-visible',
    height: 50,
    aliases: ['msg:ui:persisted-request'],
  };
  const view = await render(transcript({
    items: [runtimeRow],
    sessionKey: 'agent-session',
    navigationRequest: request,
  }));

  const initialTarget = view.host.querySelector<HTMLElement>('[data-message-id="runtime-entry-visible"]')
    ?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.equal(initialTarget?.classList.contains('app-transcript-message-highlight'), true);

  await view.rerender(transcript({
    items: [{
      id: 'msg:ui:persisted-request',
      height: 50,
      aliases: ['runtime-entry-visible'],
    }],
    sessionKey: 'agent-session',
    navigationRequest: null,
  }));

  const hydratedTarget = view.host.querySelector<HTMLElement>('[data-message-id="msg:ui:persisted-request"]')
    ?.closest<HTMLElement>('[data-transcript-window-item]');
  assert.equal(hydratedTarget?.classList.contains('app-transcript-message-highlight'), true);
});

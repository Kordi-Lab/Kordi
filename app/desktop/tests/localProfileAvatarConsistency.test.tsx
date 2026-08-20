import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  IdentityAvatar,
} from '../src/kordi-app/components/IdentityAvatar';
import {
  getActiveLocalProfileIdentity,
  resolveIdentityAvatarPresentation,
  setActiveLocalProfileIdentity,
} from '../src/kordi-app/components/localProfileIdentity';

const activeProfile = {
  avatarSeed: 'acct_alex',
  displayName: 'Alex Morgan',
  profileImageUrl: 'https://images.test/taylor.png',
};

test('self avatar presentation ignores viewer-local aliases and stale canonical avatar data', () => {
  const me = resolveIdentityAvatarPresentation({
    kind: 'human',
    seed: 'legacy-local-seed',
    name: 'Me',
    imageUrl: null,
    isSelf: true,
    activeLocalProfileIdentity: activeProfile,
  });
  const you = resolveIdentityAvatarPresentation({
    kind: 'human',
    seed: 'different-stale-seed',
    name: 'You',
    imageUrl: 'https://images.test/stale.png',
    isSelf: true,
    activeLocalProfileIdentity: activeProfile,
  });

  assert.deepEqual(me, {
    fallbackLabel: 'Alex Morgan',
    normalizedSeed: 'acct_alex',
    resolvedImageUrl: 'https://images.test/taylor.png',
  });
  assert.deepEqual(you, me);
});

test('remote avatar presentation is isolated from the signed-in profile', () => {
  assert.deepEqual(resolveIdentityAvatarPresentation({
    kind: 'human',
    seed: 'acct_peer',
    name: 'Peer User',
    imageUrl: 'https://images.test/peer.png',
    isSelf: false,
    activeLocalProfileIdentity: activeProfile,
  }), {
    fallbackLabel: 'Peer User',
    normalizedSeed: 'acct_peer',
    resolvedImageUrl: 'https://images.test/peer.png',
  });
});

test('active local profile updates the shared seed, display name, and image as one snapshot', () => {
  setActiveLocalProfileIdentity(activeProfile);

  assert.deepEqual(getActiveLocalProfileIdentity(), activeProfile);

  setActiveLocalProfileIdentity({
    avatarSeed: null,
    displayName: null,
    profileImageUrl: null,
  });
});

test('mounted self avatars react to live profile changes without changing their viewer-local label', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'https://desktop.kordi.test',
  });
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

  const host = dom.window.document.getElementById('root');
  assert.ok(host);
  const root = createRoot(host);
  try {
    setActiveLocalProfileIdentity({
      avatarSeed: 'acct_alex',
      displayName: 'Alex Morgan',
      profileImageUrl: null,
    });
    await act(async () => {
      root.render(<IdentityAvatar kind="human" seed="stale" name="Me" isSelf />);
    });
    assert.match(
      host.querySelector('img')?.getAttribute('src') ?? '',
      /\/v1\/avatars\/preview\/lorelei\/acct_alex\.png/,
    );
    assert.equal(host.textContent, '');

    await act(async () => {
      setActiveLocalProfileIdentity({
        avatarSeed: 'acct_alex',
        displayName: 'Alex Morgan',
        profileImageUrl: 'data:image/png;base64,c2h1',
      });
    });
    assert.equal(host.querySelector('img')?.getAttribute('src'), 'data:image/png;base64,c2h1');
    assert.equal(host.querySelector('[aria-label="Me avatar"]') !== null, true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    setActiveLocalProfileIdentity({
      avatarSeed: null,
      displayName: null,
      profileImageUrl: null,
    });
    previous.forEach((descriptor, key) => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
    dom.window.close();
  }
});

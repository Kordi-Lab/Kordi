import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import {
  getAvatarOverride,
  setAvatarOverride,
} from '../src/kordi-app/components/avatarOverrides';
import {
  getPersistedLocalAgentAvatarSeed,
  setLocalAgentAvatarSeed,
} from '../src/kordi-app/components/IdentityAvatar';

test('agent avatar override follows a canonical seed migration without overwriting a newer upload', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://desktop.kordi.test',
  });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousEvent = Object.getOwnPropertyDescriptor(globalThis, 'Event');
  Object.defineProperty(target, 'window', {
    configurable: true,
    writable: true,
    value: dom.window,
  });
  Object.defineProperty(target, 'Event', {
    configurable: true,
    writable: true,
    value: dom.window.Event,
  });

  try {
    setLocalAgentAvatarSeed('transient-runtime-id');
    setAvatarOverride('agent:transient-runtime-id', 'data:image/jpeg;base64,first');
    setLocalAgentAvatarSeed('canonical-id');
    assert.equal(getPersistedLocalAgentAvatarSeed(), 'canonical-id');
    assert.equal(
      getAvatarOverride('agent:canonical-id'),
      'data:image/jpeg;base64,first',
    );

    setAvatarOverride('agent:new-canonical-id', 'data:image/jpeg;base64,newer');
    setLocalAgentAvatarSeed('new-canonical-id');
    assert.equal(
      getAvatarOverride('agent:new-canonical-id'),
      'data:image/jpeg;base64,newer',
    );
  } finally {
    dom.window.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousEvent) Object.defineProperty(globalThis, 'Event', previousEvent);
    else Reflect.deleteProperty(globalThis, 'Event');
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  messageDeleteParticleActivation,
  messageDeleteReflowOffset,
} from '../src/features/chat/messageDeleteAnimation';

test('message delete particles activate from top to bottom with a bounded soft edge', () => {
  assert.equal(messageDeleteParticleActivation(0, 100, -60), 0);
  assert.equal(messageDeleteParticleActivation(50, 100, 0), 300);
  assert.equal(messageDeleteParticleActivation(100, 100, 60), 600);
  assert.ok(
    messageDeleteParticleActivation(20, 100, 0)
      < messageDeleteParticleActivation(80, 100, 0),
  );
});

test('message delete reflow starts surviving rows at their previous screen position', () => {
  assert.equal(messageDeleteReflowOffset(120, 168), -48);
  assert.equal(messageDeleteReflowOffset(168, 120), 48);
  assert.equal(messageDeleteReflowOffset(120, 120), 0);
});

test('reduced motion fades the snapshot without translating transcript rows', () => {
  const source = readFileSync(
    new URL('../src/features/chat/messageDeleteAnimation.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /animations = reduceMotion \? \[\] : prepareReflow\(before, duration\)/);
});

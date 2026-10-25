import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { PALETTES, SPECIES, TONES, seedToAvatar } from './kordi-birds/birds.mjs';
import { FIXTURES, outputs, templateSvg } from './kordi-birds/generate.mjs';

const generator = new URL('./kordi-birds/generate.mjs', import.meta.url);

test('roster tables keep the shared order', () => {
  assert.deepEqual(SPECIES.map((s) => s.key), [
    'sparrow', 'robin', 'cardinal', 'jay', 'kingfisher', 'hummingbird', 'owl', 'osprey',
    'sparrowhawk', 'eagle', 'penguin', 'puffin', 'toucan', 'heron', 'blackbird', 'cockatoo',
  ]);
  assert.deepEqual(PALETTES.map((p) => `${p.key} ${p.bg}`), [
    'paper #ffffff', 'rice #fbf5ea', 'coral #ff8a6b', 'sakura #f9c6d3',
    'butter #ffd96a', 'mint #bfe6cf', 'sky #a9d8f2', 'lavender #d6cdf3',
  ]);
  assert.deepEqual(TONES, ['color', 'slate', 'ink']);
});

test('seed fixtures match the shared contract and fixtures.json', () => {
  const json = JSON.parse(readFileSync(new URL('./kordi-birds/fixtures.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(json).length, 12);
  for (const [seed, [species, tone, palette]] of Object.entries(FIXTURES)) {
    assert.deepEqual(seedToAvatar(seed), { species, tone, palette }, seed);
    assert.deepEqual(json[seed], { species, tone, palette }, seed);
  }
});

test('server templates carry one background placeholder and only resvg-safe features', () => {
  let count = 0;
  for (const { key } of SPECIES) {
    for (const tone of TONES) {
      const svg = templateSvg(key, tone);
      count += 1;
      assert.equal(svg.split('__BG__').length, 2, `${key}-${tone}`);
      assert.match(svg, /viewBox="0 0 128 128"/);
      for (const banned of ['<filter', '<mask', '<style', 'color-mix', 'style=']) {
        assert.ok(!svg.includes(banned), `${key}-${tone} contains ${banned}`);
      }
    }
  }
  assert.equal(count, 48);
});

test('the generated browser script exposes the same API', () => {
  const script = outputs().get(new URL('../docs/design-previews/agent-bird-avatars/birds.js', import.meta.url).pathname);
  const sandbox = { window: {}, TextEncoder };
  vm.runInNewContext(script, sandbox);
  const birds = sandbox.window.KordiBirds;
  assert.equal(birds.SPECIES.length, 16);
  assert.deepEqual({ ...birds.seedToAvatar('7bbaa257') }, { species: 'penguin', tone: 'color', palette: 'mint' });
  assert.match(birds.birdSvg('owl', { palette: 'sky' }), /fill="#a9d8f2"/);
});

test('generated outputs on disk are up to date', () => {
  execFileSync(process.execPath, [generator.pathname, '--check'], { stdio: 'pipe' });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  KORDI_BIRD_BODY_GAP_PATH,
  KORDI_BIRD_STILL_WING_PATH,
  KORDI_BIRD_TAIL_GAP_PATH,
  KordiFlyingBird,
} from '../src/features/cloud/KordiFlyingBird';
import {
  stillWingPath,
  wingGapBodyHolePath,
  wingGapTailHolePath,
} from '../../../scripts/kordi-app-icons/flyingBirdCutout.mjs';

const fillPaths = (markup: string) => [...markup.matchAll(/<path class="app-kordi-flying-bird-fill"[^>]*>/g)].map(([tag]) => tag);

test('the cutout bird draws its body without an SVG mask', () => {
  const markup = renderToStaticMarkup(createElement(KordiFlyingBird, { cutout: true }));
  // A mask that fails to resolve hides the whole body and leaves only the wing.
  assert.doesNotMatch(markup, /<mask|mask=/);
  const [body, tail] = fillPaths(markup);
  assert.ok(body && tail, 'Body and tail render as filled paths');
  assert.match(body, /fill-rule="evenodd"/);
  assert.ok(body.includes(KORDI_BIRD_BODY_GAP_PATH), 'The wing gap is a hole in the body path');
  assert.ok(tail.includes(KORDI_BIRD_TAIL_GAP_PATH), 'The wing gap is a hole in the tail path');
  assert.match(markup, /class="app-kordi-flying-bird-beak"/);
  assert.ok(markup.includes(`d="${KORDI_BIRD_STILL_WING_PATH}"`));
});

test('the flying bird keeps its body, tail and flapping wing', () => {
  const markup = renderToStaticMarkup(createElement(KordiFlyingBird));
  assert.doesNotMatch(markup, /<mask|mask=/);
  assert.equal(fillPaths(markup).length, 2);
  assert.ok(!markup.includes(KORDI_BIRD_BODY_GAP_PATH));
  assert.match(markup, /<g transform="translate\(296,262\)"><path class="app-kordi-flying-bird-wing"/);
});

test('cutout geometry matches the generator', () => {
  assert.equal(KORDI_BIRD_STILL_WING_PATH, stillWingPath());
  assert.equal(KORDI_BIRD_BODY_GAP_PATH, wingGapBodyHolePath());
  assert.equal(KORDI_BIRD_TAIL_GAP_PATH, wingGapTailHolePath());
});

test('the sign-in screens give the bird body a solid color in both themes', () => {
  const css = readFileSync(new URL('../src/styles/theme-cloud-signin.css', import.meta.url), 'utf8');
  const gate = readFileSync(new URL('../src/styles/theme-auth-gate.css', import.meta.url), 'utf8');
  // The last rule for exactly this selector that sets the bird color.
  const birdColor = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blocks = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, 'g'))].map((match) => match[1]);
    return blocks.map((block) => block.match(/--app-kordi-bird:\s*([^;]+);/)?.[1].trim()).filter(Boolean).at(-1);
  };
  assert.equal(birdColor('.app-cloud-browser-signin'), '#f4ede1');
  assert.equal(birdColor('.kordi-app.theme-light .app-cloud-browser-signin'), '#1f1a17');
  assert.match(gate, /\.app-kordi-flying-bird-fill \{\s*fill: var\(--app-kordi-bird, currentColor\);/);
  // The cutout wing is tilted in its path, so no CSS transform may move it again.
  assert.doesNotMatch(css, /flying-bird-wing[^{]*\{[^}]*rotate\(/);
});

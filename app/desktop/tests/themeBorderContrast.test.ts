import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const palette = readFileSync(new URL('../src/styles/theme-palette.css', import.meta.url), 'utf8');

function tokenAlphas(name: string): number[] {
  const pattern = new RegExp(`--app-palette-${name}:\\s*oklch\\([^;]*\\/\\s*([0-9.]+)\\);`, 'g');
  return [...palette.matchAll(pattern)].map((match) => Number(match[1]));
}

// Tinted themes draw lines on tinted, translucent surfaces. Their alphas were
// raised until each line measured at least Classic's contrast in the compact shell.
test('tinted themes keep borders and dividers at least as visible as Classic', () => {
  const [darkBorder, lightBorder, classicDarkBorder, classicLightBorder] = tokenAlphas('border');
  const [darkDivider, lightDivider, classicDarkDivider, classicLightDivider] = tokenAlphas('divider');

  assert.ok(lightBorder >= 0.22, `light border alpha ${lightBorder}`);
  assert.ok(lightDivider >= 0.16, `light divider alpha ${lightDivider}`);
  assert.ok(darkBorder >= 0.18, `dark border alpha ${darkBorder}`);
  assert.ok(darkDivider >= 0.12, `dark divider alpha ${darkDivider}`);
  // Classic keeps its neutral hairlines.
  assert.equal(classicDarkBorder, 0.16);
  assert.equal(classicDarkDivider, 0.1);
  assert.equal(classicLightBorder, 0.15);
  assert.equal(classicLightDivider, 0.1);
});

test('tinted light selection stays distinct from the session list', () => {
  assert.match(
    palette,
    /--app-palette-selected:\s*oklch\(87% calc\(0\.04 \* var\(--app-palette-chroma\)\) var\(--app-palette-hue\) \/ 0\.88\);/,
  );
  assert.match(palette, /--app-palette-selected:\s*rgba\(0, 0, 0, 0\.06\);/);
});

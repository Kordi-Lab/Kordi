import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readDesktopShellCss } from './helpers/readDesktopStyles';

test('dark theme uses a translucent dark-glass palette with one accent selected state', () => {
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--utility-background:\s*rgb\(15 17 21\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--utility-foreground:\s*rgba\(255,\s*255,\s*255,\s*0\.9\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--utility-muted-text:\s*rgba\(255,\s*255,\s*255,\s*0\.6\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--utility-meta-text:\s*rgba\(255,\s*255,\s*255,\s*0\.35\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-card-bg:\s*rgba\(255,\s*255,\s*255,\s*0\.04\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-control-bg:\s*rgba\(255,\s*255,\s*255,\s*0\.04\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-control-hover:\s*rgba\(255,\s*255,\s*255,\s*0\.06\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-divider:\s*rgba\(255,\s*255,\s*255,\s*0\.08\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-accent:\s*rgba\(132,\s*122,\s*196,\s*0\.64\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-accent-ring:\s*rgba\(132,\s*122,\s*196,\s*0\.26\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-control-active:\s*rgba\(132,\s*122,\s*196,\s*0\.11\);/);
});

test('chat sidebar timestamps use the tertiary text token', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /\.app-session-meta-time\s*{[^}]*color:\s*var\(--utility-meta-text\)/s);
  assert.match(shellCss, /\.app-session-meta-time-active\s*{[^}]*color:\s*color-mix\(in oklab, var\(--utility-muted-text\) 72%, var\(--utility-foreground\)\)/s);
  assert.match(shellCss, /\.app-session-row-active\s*{[^}]*border:\s*1px solid transparent;[^}]*box-shadow:\s*0 0 0 1px var\(--app-accent-ring\)/s);
});

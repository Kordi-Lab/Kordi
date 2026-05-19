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
  assert.match(shellCss, /\.app-session-row\s*{[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-session-row-active\s*{[^}]*border:\s*1px solid color-mix\(in oklab, var\(--app-accent-ring\) 92%, var\(--app-divider\)\);[^}]*box-shadow:\s*0 0 0 1px color-mix\(in oklab, var\(--app-accent-ring\) 42%, transparent\)/s);
});

test('glassmorphism tokens are declared in both themes and frame bgs are translucent', () => {
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

  // Glass intensity tokens — shared across themes (declared in the base block).
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-glass-blur-frame:\s*12px;/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-glass-blur-float:\s*8px;/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-glass-saturate-frame:\s*1\.06;/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-glass-saturate-float:\s*1\.04;/);

  // Inner-top highlight and paper-grain tokens — declared in both themes.
  // Light mode is intentionally neutral (transparent grain, white highlight).
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-glass-highlight:\s*rgba\(255,\s*255,\s*255,\s*0\.05\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-paper-grain:\s*transparent;/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-glass-highlight:\s*rgba\(255,\s*255,\s*255,\s*0\.55\);/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-paper-grain:\s*transparent;/);

  // Dark frame bgs lowered so backdrop-filter reads through.
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-shell-bg:\s*rgba\(15,\s*17,\s*21,\s*0\.62\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-side-bg:\s*rgba\(15,\s*17,\s*21,\s*0\.56\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-session-bg:\s*rgba\(15,\s*17,\s*21,\s*0\.52\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-main-bg:\s*rgba\(15,\s*17,\s*21,\s*0\.62\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-modal-bg:\s*rgba\(17,\s*19,\s*24,\s*0\.66\);/);

  // Light frame bgs are now neutral-white translucent (no paper warmth).
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-shell-bg:\s*linear-gradient\(180deg,\s*rgba\(252,\s*252,\s*253,\s*0\.72\)/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-side-bg:\s*rgba\(250,\s*250,\s*251,\s*0\.66\);/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-modal-bg:\s*rgba\(255,\s*255,\s*255,\s*0\.80\);/);
});

test('light agent workspace uses cool slate surfaces instead of warm beige panels', () => {
  const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');
  const agentBlockStart = themeOverridesCss.indexOf('.bridge-app.theme-light .app-agent-shell');
  const agentBlockEnd = themeOverridesCss.indexOf('.bridge-app.theme-light .app-workspace-sidebar .app-sidebar-panel-section', agentBlockStart);
  const agentLightBlock = themeOverridesCss.slice(agentBlockStart, agentBlockEnd);

  assert.ok(agentBlockStart >= 0 && agentBlockEnd > agentBlockStart, 'expected to find the light agent theme block');
  assert.match(agentLightBlock, /\.app-agent-shell\s*{[^}]*border-color:\s*color-mix\(in oklab, rgb\(148 163 184\) 26%, transparent\);[^}]*background:\s*color-mix\(in oklab, rgb\(226 232 240\) 48%, transparent\)/s);
  assert.match(agentLightBlock, /\.app-agent-sidebar\s*{[^}]*background:\s*color-mix\(in oklab, rgb\(248 250 252\) 86%, transparent\)/s);
  assert.match(agentLightBlock, /\.app-agent-detail-pane\s*{[^}]*background:\s*color-mix\(in oklab, rgb\(241 245 249\) 78%, transparent\)/s);
  assert.match(agentLightBlock, /\.app-agent-content-pane\s*{[^}]*border-left-color:\s*color-mix\(in oklab, rgb\(148 163 184\) 28%, transparent\);[^}]*background:\s*color-mix\(in oklab, rgb\(238 242 247\) 82%, transparent\)/s);
  assert.doesNotMatch(agentLightBlock, /rgb\(245 241 232\)|rgba\(255, 252, 244|rgba\(247, 244, 235|rgba\(243, 239, 229|rgba\(73, 62, 54/);
});

test('shell.css applies backdrop-filter and a paper-grain layer on the workspace shell', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');

  // @supports query gates the blur so unsupported environments still render.
  assert.match(shellCss, /@supports\s*\(backdrop-filter:\s*blur\(12px\)\)/);
  // Frame surfaces share the frame-tier blur token.
  assert.match(shellCss, /backdrop-filter:\s*blur\(var\(--app-glass-blur-frame\)\)\s+saturate\(var\(--app-glass-saturate-frame\)\)/);
  // Float surfaces share the float-tier blur token.
  assert.match(shellCss, /backdrop-filter:\s*blur\(var\(--app-glass-blur-float\)\)\s+saturate\(var\(--app-glass-saturate-float\)\)/);
  // Paper-grain layer is painted on .app-shell::before with multiply blend.
  assert.match(shellCss, /\.app-shell::before\s*{[\s\S]*background-image:\s*repeating-linear-gradient\(\s*7deg,\s*var\(--app-paper-grain\)/);
  assert.match(shellCss, /\.app-shell::before\s*{[\s\S]*mix-blend-mode:\s*multiply/);
});

test('composer send area keeps the outer surface without an inner input pop or divider', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');
  const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');
  const composerShellBlock = shellCss.match(/\.app-composer-shell \{[\s\S]*?\n\}/)?.[0] ?? '';
  const composerInputBlock = shellCss.match(/\.app-composer-input \{[\s\S]*?\n\}/)?.[0] ?? '';
  const composerMetaBlock = shellCss.match(/\.app-composer-meta \{[\s\S]*?\n\}/)?.[0] ?? '';
  const composerFocusBlock = shellCss.match(/\.app-composer-shell:focus-within \{[\s\S]*?\n\}/)?.[0] ?? '';
  const lightComposerFocusBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-composer-shell:focus-within \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(composerShellBlock, /var\(--app-divider\) 86%/);
  assert.match(composerShellBlock, /box-shadow:/);
  assert.match(composerInputBlock, /border:\s*0/);
  assert.match(composerInputBlock, /background:\s*transparent/);
  assert.match(composerInputBlock, /box-shadow:\s*none/);
  assert.match(composerMetaBlock, /border-top:\s*0/);
  assert.match(composerFocusBlock, /var\(--app-accent-ring\)/);
  assert.doesNotMatch(shellCss, /\.app-composer-shell:focus-within \.app-composer-input/);
  assert.doesNotMatch(themeOverridesCss, /\.bridge-app\.theme-light \.app-composer-input \{[^}]*background:/);
  assert.match(lightComposerFocusBlock, /box-shadow:/);
});

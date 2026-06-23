import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readDesktopShellCss } from './helpers/readDesktopStyles';

test('dual themes expose semantic surface, text, border, ring, and depth tokens', () => {
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');
  const darkBlock = themeTokensCss.match(/\.bridge-app\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const lightBlock = themeTokensCss.match(/\.bridge-app\.theme-light\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  for (const block of [darkBlock, lightBlock]) {
    assert.match(block, /--app-surface-canvas:/);
    assert.match(block, /--app-surface-shell:/);
    assert.match(block, /--app-surface-rail:/);
    assert.match(block, /--app-surface-panel:/);
    assert.match(block, /--app-surface-card:/);
    assert.match(block, /--app-surface-float:/);
    assert.match(block, /--app-text-primary:/);
    assert.match(block, /--app-text-secondary:/);
    assert.match(block, /--app-text-muted:/);
    assert.match(block, /--app-text-meta:/);
    assert.match(block, /--app-border-subtle:/);
    assert.match(block, /--app-border-strong:/);
    assert.match(block, /--app-ring-focus:/);
    assert.match(block, /--app-depth-1:/);
    assert.match(block, /--app-depth-2:/);
    assert.match(block, /--app-depth-3:/);
  }

  assert.match(darkBlock, /--app-surface-canvas:\s*rgb\(13 15 19\);/);
  assert.match(darkBlock, /--app-text-primary:\s*rgb\(241 245 249\);/);
  assert.match(darkBlock, /--app-depth-1:\s*0 0 0 1px rgba\(148, 163, 184, 0\.08\);/);
  assert.match(lightBlock, /--app-surface-canvas:\s*rgb\(248 250 252\);/);
  assert.match(lightBlock, /--app-text-primary:\s*rgb\(15 23 42\);/);
  assert.match(lightBlock, /--app-divider:\s*var\(--app-border-subtle\);/);
  assert.doesNotMatch(lightBlock, /--app-divider:\s*rgba\(43, 35, 32/);
  assert.doesNotMatch(lightBlock, /--app-control-bg:\s*rgba\(43, 35, 32/);
});

test('dark theme uses graphite semantic aliases with one restrained accent selected state', () => {
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--utility-background:\s*var\(--app-surface-canvas\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--utility-foreground:\s*var\(--app-text-primary\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--utility-muted-text:\s*var\(--app-text-muted\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--utility-meta-text:\s*var\(--app-text-meta\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-card-bg:\s*var\(--app-surface-card\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-control-bg:\s*rgba\(148,\s*163,\s*184,\s*0\.08\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-control-hover:\s*rgba\(148,\s*163,\s*184,\s*0\.12\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-divider:\s*var\(--app-border-subtle\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-accent:\s*rgba\(132,\s*122,\s*196,\s*0\.64\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-accent-ring:\s*var\(--app-ring-focus\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-control-active:\s*var\(--app-accent-primary-surface\);/);
});

test('chat sidebar timestamps use the sidebar time text token', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /\.app-session-meta-time\s*{[^}]*color:\s*var\(--app-sidebar-time-text\)/s);
  assert.match(shellCss, /\.app-session-meta-time-active\s*{[^}]*color:\s*var\(--app-sidebar-time-text\)/s);
  assert.match(shellCss, /\.app-session-row\s*{[^}]*box-shadow:\s*none/s);
  assert.match(shellCss, /\.app-session-row-active\s*{[^}]*background:\s*var\(--app-sidebar-selected-bg\);[^}]*box-shadow:\s*none/s);
});

test('glassmorphism tokens are declared in both themes and frame bgs are translucent', () => {
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

  // Glass intensity tokens — shared across themes (declared in the base block).
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-glass-blur-frame:\s*10px;/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-glass-blur-float:\s*8px;/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-glass-saturate-frame:\s*1\.02;/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-glass-saturate-float:\s*1\.02;/);

  // Inner-top highlight and paper-grain tokens — declared in both themes.
  // Light mode is intentionally neutral (transparent grain, white highlight).
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-glass-highlight:\s*rgba\(255,\s*255,\s*255,\s*0\.045\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-paper-grain:\s*transparent;/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-glass-highlight:\s*rgba\(255,\s*255,\s*255,\s*0\.55\);/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-paper-grain:\s*transparent;/);

  // Dark frame bgs lowered so backdrop-filter reads through.
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-shell-bg:\s*var\(--app-surface-shell\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-side-bg:\s*var\(--app-surface-rail\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-session-bg:\s*var\(--app-surface-rail\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-main-bg:\s*var\(--app-surface-panel\);/);
  assert.match(themeTokensCss, /\.bridge-app\s*{[\s\S]*--app-modal-bg:\s*var\(--app-surface-float\);/);

  // Light frame bgs are now neutral-cool translucent (no paper warmth).
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-shell-bg:\s*var\(--app-surface-shell\);/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-side-bg:\s*var\(--app-surface-rail\);/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-modal-bg:\s*var\(--app-surface-float\);/);
});

test('light cloud login and loading gates use the cool main-shell palette', () => {
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');
  const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');
  const lightTokenBlock = themeTokensCss.match(/\.bridge-app\.theme-light\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const lightCloudTokenBlock = lightTokenBlock.slice(lightTokenBlock.indexOf('--app-cloud-login-raised-bg:'));
  const lightCloudBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-cloud-login-page,[\s\S]*?\n\}/)?.[0] ?? '';
  const lightAccentsBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-cloud-login-accents \{[\s\S]*?\n\}/)?.[0] ?? '';
  const lightStartingBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-cloud-starting-screen \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(lightCloudTokenBlock, /--app-cloud-login-raised-bg:\s*rgba\(255,\s*255,\s*255,\s*0\.72\);/);
  assert.match(lightCloudTokenBlock, /--app-cloud-login-sunk-bg:\s*rgba\(226,\s*232,\s*240,\s*0\.52\);/);
  assert.match(lightCloudTokenBlock, /--app-cloud-login-input-bg:\s*rgba\(248,\s*251,\s*255,\s*0\.82\);/);
  assert.match(lightCloudTokenBlock, /--app-cloud-login-border:\s*rgba\(37,\s*99,\s*235,\s*0\.12\);/);
  assert.match(lightCloudTokenBlock, /--app-cloud-login-divider:\s*rgba\(100,\s*116,\s*139,\s*0\.22\);/);
  assert.match(lightCloudBlock, /--app-cloud-login-page-bg:\s*linear-gradient\(180deg,\s*rgb\(248 250 252\) 0%,\s*rgb\(241 245 249\) 54%,\s*rgb\(226 232 240\) 100%\);/);
  assert.match(lightAccentsBlock, /oklch\(0\.70 0\.13 232 \/ 0\.12\)/);
  assert.match(lightAccentsBlock, /oklch\(0\.74 0\.11 190 \/ 0\.10\)/);
  assert.match(lightStartingBlock, /--app-cloud-starting-dot-a:\s*oklch\(0\.56 0\.13 232 \/ 0\.68\);/);
  assert.match(lightStartingBlock, /--app-cloud-starting-dot-c:\s*oklch\(0\.50 0\.07 255 \/ 0\.62\);/);
  assert.doesNotMatch(`${lightCloudTokenBlock}\n${lightCloudBlock}\n${lightAccentsBlock}\n${lightStartingBlock}`, /oklch\([^)]*\s82(?:\s|\/|\))|rgba\(255,\s*252|rgb\(245 241 232\)|0\.955 0\.026 82/);
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

test('light theme utility buttons use flat navigation-chip styling instead of raised glass', () => {
  const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');
  const raisedSurfaceBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-input-shell,[\s\S]*?\.app-surface-muted\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const flatButtonBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-icon-button,[\s\S]*?\.app-control-chip\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const flatButtonHoverBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-icon-button:hover,[\s\S]*?\.app-control-chip:hover\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const activeChipBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-control-chip-active\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.doesNotMatch(raisedSurfaceBlock, /\.app-icon-button|\.app-utility-button|\.app-control-chip/);
  assert.match(flatButtonBlock, /background:\s*rgba\(15, 23, 42, 0\.055\);/);
  assert.match(flatButtonBlock, /box-shadow:\s*none;/);
  assert.doesNotMatch(flatButtonBlock, /0 8px 18px|0 -2px 6px|inset 0 -1px/);
  assert.match(flatButtonHoverBlock, /background:\s*rgba\(15, 23, 42, 0\.08\);/);
  assert.match(activeChipBlock, /background:\s*rgba\(15, 23, 42, 0\.095\);/);
  assert.match(activeChipBlock, /box-shadow:\s*none;/);
});

test('shell structural surfaces use semantic depth without decorative warm rail glow', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');
  const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');
  const leftGlassBlock = shellCss.match(/\.app-left-glass\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const lightStructuralBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-left-glass,[\s\S]*?\.app-main-panel\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(leftGlassBlock, /background:\s*var\(--app-left-glass-bg\);/);
  assert.match(leftGlassBlock, /box-shadow:\s*var\(--app-depth-1\);/);
  assert.doesNotMatch(leftGlassBlock, /214, 158, 46|255, 194, 84/);
  assert.match(lightStructuralBlock, /box-shadow:\s*var\(--app-depth-1\);/);
  assert.doesNotMatch(lightStructuralBlock, /0 8px 20px|0 -3px 8px|inset 0 -1px/);
});

test('composer send area keeps the outer surface without an inner input pop or divider', () => {
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');
  const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');
  const composerShellBlock = shellCss.match(/\.app-composer-shell \{[\s\S]*?\n\}/)?.[0] ?? '';
  const composerInputBlock = shellCss.match(/\.app-composer-input \{[\s\S]*?\n\}/)?.[0] ?? '';
  const composerMetaBlock = shellCss.match(/\.app-composer-meta \{[\s\S]*?\n\}/)?.[0] ?? '';
  const composerFocusBlock = shellCss.match(/\.app-composer-shell:focus-within \{[\s\S]*?\n\}/)?.[0] ?? '';
  const lightComposerBlock = Array.from(themeOverridesCss.matchAll(/\.bridge-app\.theme-light \.app-composer-shell \{[\s\S]*?\n\}/g))
    .map((match) => match[0])
    .find((block) => /background:/.test(block)) ?? '';
  const lightComposerFocusBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-composer-shell:focus-within \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(composerShellBlock, /var\(--app-divider\) 86%/);
  assert.match(composerShellBlock, /box-shadow:/);
  assert.match(composerInputBlock, /border:\s*0/);
  assert.match(composerInputBlock, /background:\s*transparent/);
  assert.match(composerInputBlock, /box-shadow:\s*none/);
  assert.match(composerMetaBlock, /border-top:\s*0/);
  assert.match(composerFocusBlock, /var\(--app-ring-focus\)/);
  assert.doesNotMatch(shellCss, /\.app-composer-shell:focus-within \.app-composer-input/);
  assert.doesNotMatch(themeOverridesCss, /\.bridge-app\.theme-light \.app-composer-input \{[^}]*background:/);
  assert.match(lightComposerBlock, /background:\s*var\(--app-surface-float\);/);
  assert.match(lightComposerBlock, /border-color:\s*var\(--app-border-subtle\);/);
  assert.doesNotMatch(lightComposerBlock, /rgba\(37, 99, 235|rgba\(252, 249, 243|rgba\(246, 241, 232/);
  assert.match(lightComposerFocusBlock, /border-color:\s*var\(--app-border-strong\);/);
  assert.match(lightComposerFocusBlock, /var\(--app-ring-focus\)/);
});

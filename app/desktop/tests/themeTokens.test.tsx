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

  // Light frame bgs use a high-lightness translucent white family.
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-shell-bg:\s*linear-gradient\(180deg,\s*rgba\(252,\s*252,\s*253,\s*0\.72\)/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-side-bg:\s*oklch\(99\.2% 0\.001 80 \/ 0\.58\);/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-session-bg:\s*oklch\(99\.4% 0\.001 80 \/ 0\.68\);/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-native-session-bg:\s*var\(--app-session-bg\);/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-native-session-fallback:\s*oklch\(98\.6% 0\.002 80\);/);
  assert.match(themeTokensCss, /\.bridge-app\.theme-light\s*{[\s\S]*--app-modal-bg:\s*rgba\(255,\s*255,\s*255,\s*0\.80\);/);
});

test('light workspace pages share one flat near-white surface family in web and native shells', () => {
  const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8');
  const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');
  const appShellFrame = readFileSync(new URL('../src/app/AppShellFrame.tsx', import.meta.url), 'utf8');
  const rightDetailRail = readFileSync(new URL('../src/pages/RightDetailRail.tsx', import.meta.url), 'utf8');
  const cloudAccountSettings = readFileSync(new URL('../src/pages/CloudAccountSettingsDialog.tsx', import.meta.url), 'utf8');
  const lightTokenBlock = themeTokensCss.match(/\.bridge-app\.theme-light\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const lightPageHeaderBlock = themeOverridesCss.match(/\.bridge-app\.theme-light \.app-page-header \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(lightTokenBlock, /--app-main-bg:\s*oklch\(98\.9% 0\.001 80\);/);
  assert.match(lightTokenBlock, /--app-main-raised-bg:\s*oklch\(99\.6% 0\.001 80\);/);
  assert.match(lightTokenBlock, /--app-main-muted-bg:\s*oklch\(97\.3% 0\.002 80\);/);
  assert.match(lightTokenBlock, /--app-native-main-bg:\s*var\(--app-main-bg\);/);
  assert.doesNotMatch(lightTokenBlock, /--app-main-bg:\s*linear-gradient/);
  assert.match(shellCss, /\.app-main-panel\s*\{[^}]*background:\s*var\(--app-main-bg\);/s);
  assert.match(appShellFrame, /isSingleWorkspacePage \? 'app-main-panel/);
  assert.match(rightDetailRail, /app-main-panel app-right-detail-rail/);
  assert.match(cloudAccountSettings, /app-main-panel app-cloud-account-settings-page/);
  assert.match(lightPageHeaderBlock, /background:\s*transparent;/);
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

test('agent workspace is a full-bleed continuous surface with structural dividers', () => {
  const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');
  const shellPagesCss = readFileSync(new URL('../src/styles/shell-pages.css', import.meta.url), 'utf8');
  const agentsPageSource = readFileSync(new URL('../src/kordi-app/agents/AgentsPage.tsx', import.meta.url), 'utf8');
  const agentSharedSource = readFileSync(new URL('../src/kordi-app/agents/shared.tsx', import.meta.url), 'utf8');
  const agentBlockStart = themeOverridesCss.indexOf('.bridge-app.theme-light .app-agent-shell');
  const agentBlockEnd = themeOverridesCss.indexOf('.bridge-app.theme-light .app-workspace-sidebar .app-sidebar-panel-section', agentBlockStart);
  const agentLightBlock = themeOverridesCss.slice(agentBlockStart, agentBlockEnd);

  assert.ok(agentBlockStart >= 0 && agentBlockEnd > agentBlockStart, 'expected to find the light agent theme block');
  assert.match(shellPagesCss, /\.app-agents-page\s*{[^}]*padding:\s*0;/s);
  assert.match(shellPagesCss, /\.app-agent-shell\s*{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(shellPagesCss, /\.app-agent-sidebar\s*{[^}]*border-right:\s*1px solid[^}]*background:\s*transparent;/s);
  assert.match(shellPagesCss, /\.app-agent-detail-pane\s*{[^}]*border-right:\s*1px solid[^}]*background:\s*transparent;/s);
  assert.match(agentLightBlock, /\.app-agent-shell\s*{[^}]*border-color:\s*transparent;[^}]*background:\s*transparent;/s);
  assert.match(agentLightBlock, /\.app-agent-sidebar,[\s\S]*?\.app-agent-detail-pane\s*{[^}]*border-right-color:\s*color-mix\(in oklab, rgb\(148 163 184\) 28%, transparent\);[^}]*background:\s*transparent;/s);
  assert.match(agentLightBlock, /\.app-agent-content-pane\s*{[^}]*background:\s*transparent;/s);
  assert.match(agentLightBlock, /\.app-agent-inner-list,[\s\S]*?\.app-agent-inspector-row\s*{[^}]*background:\s*var\(--app-main-raised-bg\);/s);
  assert.match(agentLightBlock, /\.app-agent-code-panel\s*{[^}]*background:\s*var\(--app-main-muted-bg\);/s);
  assert.doesNotMatch(agentsPageSource, /app-agents-page[^"\n]*\bp-[0-9]/);
  assert.doesNotMatch(agentsPageSource, /app-agent-shell[^"\n]*(?:rounded|border)/);
  assert.match(agentSharedSource, /app-agent-section border-t pt-5/);
  assert.doesNotMatch(agentSharedSource, /app-agent-section[^"\n]*(?:rounded|\bborder\b(?!-t))/);
  assert.doesNotMatch(agentLightBlock, /background:[^;]*(?:rgb\(241 245 249\)|rgb\(248 250 252\))/);
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
  assert.match(composerFocusBlock, /var\(--app-accent-ring\)/);
  assert.doesNotMatch(shellCss, /\.app-composer-shell:focus-within \.app-composer-input/);
  assert.doesNotMatch(themeOverridesCss, /\.bridge-app\.theme-light \.app-composer-input \{[^}]*background:/);
  assert.match(lightComposerBlock, /background:\s*var\(--app-main-raised-bg\);/);
  assert.match(lightComposerBlock, /border-color:\s*rgba\(37, 99, 235, 0\.12\);/);
  assert.doesNotMatch(lightComposerBlock, /linear-gradient|rgba\(248, 251, 255|rgba\(241, 247, 255/);
  assert.match(lightComposerFocusBlock, /border-color:\s*rgba\(37, 99, 235, 0\.22\);/);
  assert.match(lightComposerFocusBlock, /background:\s*var\(--app-main-raised-bg\);/);
  assert.match(lightComposerFocusBlock, /box-shadow:/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dialogSource = readFileSync(new URL('../src/kordi-app/agents/AgentCreateDialog.tsx', import.meta.url), 'utf8');
const shellPagesCss = readFileSync(new URL('../src/styles/shell-pages.css', import.meta.url), 'utf8');
const themeTokensCss = readFileSync(new URL('../src/styles/theme-tokens.css', import.meta.url), 'utf8');

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[0];
}

test('create cloud agent dialog uses shared modal overlay instead of a harsh bespoke blackout', () => {
  assert.match(dialogSource, /className="app-overlay app-agent-create-overlay fixed inset-0/);
  assert.doesNotMatch(dialogSource, /bg-black\/55|backdrop-blur-sm/);

  const overlayRule = cssRule(shellPagesCss, '.app-agent-create-overlay');
  assert.match(overlayRule, /background:\s*var\(--app-overlay-bg\);/);
  assert.match(overlayRule, /backdrop-filter:\s*blur\(10px\);/);
});

test('create cloud agent dialog uses a soft large-dialog depth token and neutral hairline border', () => {
  assert.match(dialogSource, /className="app-modal-panel app-agent-create-dialog/);
  assert.doesNotMatch(dialogSource, /shadow-\[var\(--app-shadow-float\)\]/);
  assert.doesNotMatch(dialogSource, /border-white\/10/);

  const dialogRule = cssRule(shellPagesCss, '.app-agent-create-dialog');
  assert.match(dialogRule, /border-color:\s*color-mix\(in oklab, var\(--app-divider\) 82%, transparent\);/);
  assert.match(dialogRule, /box-shadow:\s*var\(--app-shadow-dialog\);/);
  assert.match(dialogRule, /background:\s*var\(--app-modal-bg\);/);

  assert.match(themeTokensCss, /--app-shadow-dialog:/);
  assert.match(themeTokensCss, /0 16px 42px rgba\(0, 0, 0, 0\.18\)/);
  assert.match(themeTokensCss, /0 18px 44px rgba\(0, 0, 0, 0\.10\)/);
});

test('create cloud agent dialog body, footer, and scrollbars are integrated rather than heavy', () => {
  assert.match(dialogSource, /app-agent-create-body/);
  assert.match(dialogSource, /app-agent-create-footer/);
  assert.match(dialogSource, /app-agent-create-source-card/);
  assert.match(dialogSource, /app-agent-create-empty-draft/);

  const bodyRule = cssRule(shellPagesCss, '.app-agent-create-body');
  const footerRule = cssRule(shellPagesCss, '.app-agent-create-footer');
  const sourceCardRule = cssRule(shellPagesCss, '.app-agent-create-source-card');
  const emptyDraftRule = cssRule(shellPagesCss, '.app-agent-create-empty-draft');

  assert.match(bodyRule, /scrollbar-width:\s*thin;/);
  assert.match(bodyRule, /scrollbar-color:\s*color-mix\(in oklab, var\(--utility-muted-text\) 34%, transparent\) transparent;/);
  assert.match(footerRule, /background:\s*color-mix\(in oklab, var\(--app-modal-bg\) 94%, var\(--app-control-bg\)\);/);
  assert.match(sourceCardRule, /border-style:\s*solid;/);
  assert.match(emptyDraftRule, /border-style:\s*solid;/);
});

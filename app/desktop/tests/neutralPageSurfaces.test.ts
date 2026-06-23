import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[0];
}

const themeOverridesCss = readFileSync(new URL('../src/styles/theme-overrides.css', import.meta.url), 'utf8');

test('light agents page uses neutral surfaces without blue tinted panels', () => {
  const shellRule = cssRule(themeOverridesCss, '.bridge-app.theme-light .app-agent-shell');
  const detailRule = cssRule(themeOverridesCss, '.bridge-app.theme-light .app-agent-detail-pane');
  const contentRule = cssRule(themeOverridesCss, '.bridge-app.theme-light .app-agent-content-pane');
  const activeRule = cssRule(themeOverridesCss, '.bridge-app.theme-light .app-agent-list-row-active,\n.bridge-app.theme-light .app-agent-inspector-row-active');
  const skillSelectedRule = cssRule(themeOverridesCss, '.bridge-app.theme-light .app-agent-skill-chip-selected');

  for (const rule of [shellRule, detailRule, contentRule, activeRule, skillSelectedRule]) {
    assert.doesNotMatch(rule, /rgb\(219 234 254\)|rgb\(37 99 235\)|rgb\(30 64 175\)|rgb\(238 242 247\)|rgb\(241 245 249\)/);
  }

  assert.match(shellRule, /background:\s*rgb\(245 245 245\);/);
  assert.match(detailRule, /background:\s*rgb\(250 250 250\);/);
  assert.match(contentRule, /background:\s*rgb\(250 250 250\);/);
  assert.match(activeRule, /background:\s*rgb\(238 238 238\);/);
  assert.match(skillSelectedRule, /color:\s*rgb\(17 17 17\) !important;/);
});

test('light provider gate is neutral and avoids colored warm/green page haze', () => {
  const gatePanelRule = cssRule(themeOverridesCss, '.bridge-app.theme-light .app-auth-gate-panel');
  const gateCardRule = cssRule(themeOverridesCss, '.bridge-app.theme-light .app-auth-provider-gate-card');
  const glyphRule = cssRule(themeOverridesCss, '.bridge-app.theme-light .app-auth-provider-glyph');

  assert.match(gatePanelRule, /background:\s*rgb\(255 255 255\) !important;/);
  assert.match(gatePanelRule, /box-shadow:\s*var\(--app-depth-2\) !important;/);
  assert.match(gateCardRule, /background:\s*transparent !important;/);
  assert.match(glyphRule, /background:\s*rgb\(245 245 245\) !important;/);

  for (const rule of [gatePanelRule, gateCardRule, glyphRule]) {
    assert.doesNotMatch(rule, /37,\s*99,\s*235|52,\s*211,\s*153|20,\s*184,\s*166|emerald|blue|linear-gradient/);
  }
});

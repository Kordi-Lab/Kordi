import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readDesktopShellCss } from './helpers/readDesktopStyles';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

test('settings pages render titled sections of divided rows without card shells', () => {
  const settingsPage = readSource('pages/SettingsPage.tsx');
  const cloudSettings = readSource('pages/CloudAccountSettingsDialog.tsx');
  const layout = readSource('kordi-app/components/settingsLayout.tsx');
  const shellCss = readDesktopShellCss();

  for (const source of [settingsPage, cloudSettings]) {
    assert.match(source, /<SettingsSection title=/);
    assert.match(source, /<SettingsRow/);
    assert.match(source, /app-settings-option-row/);
    assert.doesNotMatch(source, /app-surface-muted app-settings-surface/);
    assert.doesNotMatch(source, /border-t border-white\/10/);
  }
  assert.match(cloudSettings, /app-cloud-account-theme app-settings-option-list/);
  assert.doesNotMatch(cloudSettings, /app-cloud-account-settings-divider border-t/);
  assert.doesNotMatch(cloudSettings, /app-cloud-account-settings-meta-row[^\n]*border-t/);

  // One heading per section, rows separated by thin dividers, no nested cards.
  assert.match(layout, /<h2[\s\S]*?font-semibold/);
  assert.match(layout, /app-settings-rows divide-y divide-\[color:var\(--app-divider\)\]/);
  assert.doesNotMatch(layout, /app-settings-section[^\n]*(?:rounded-|bg-white|shadow-)/);
  assert.match(shellCss, /\.app-settings-option-row,\s*\.app-settings-section\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/);
});

test('settings navigation is one shared searchable rail with grouped items and a filled active pill', () => {
  const settingsPage = readSource('pages/SettingsPage.tsx');
  const cloudSettings = readSource('pages/CloudAccountSettingsDialog.tsx');
  const layout = readSource('kordi-app/components/settingsLayout.tsx');
  const shellCss = readDesktopShellCss();

  for (const source of [settingsPage, cloudSettings]) {
    assert.match(source, /<SettingsNav/);
    assert.doesNotMatch(source, /app-list-item-active/);
  }
  assert.match(cloudSettings, /label: 'Account',[\s\S]*id: 'profile'[\s\S]*id: 'devices'[\s\S]*label: 'Settings',[\s\S]*id: 'auth'[\s\S]*id: 'notifications'[\s\S]*id: 'appearance'/);
  assert.match(layout, /aria-label="Search settings"/);
  assert.match(layout, /app-settings-nav-item/);
  assert.match(layout, /app-settings-nav-item-active/);
  assert.match(layout, /aria-current=\{active \? 'page' : undefined\}/);
  assert.doesNotMatch(layout, /\buppercase\b/);

  assert.match(shellCss, /\.app-settings-nav-item\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;[\s\S]*?transition:\s*none;/);
  assert.match(shellCss, /\.app-settings-nav-item:hover\s*\{[\s\S]*?background:\s*var\(--app-quiet-control-hover-bg\)/);
  assert.match(shellCss, /\.app-settings-nav-item:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--app-quiet-control-focus-ring\)/);
  assert.match(shellCss, /\.app-settings-nav-item-active,[\s\S]*?\{[\s\S]*?background:\s*var\(--app-quiet-control-selected-bg\)/);
});

test('setting controls are compact right-hand selects, switches and buttons', () => {
  const controls = readSource('kordi-app/components/settings.tsx');
  const layout = readSource('kordi-app/components/settingsLayout.tsx');

  assert.match(controls, /mode: 'auto', label: 'System'/);
  assert.match(controls, /<SettingsSelect\s+label="App appearance"/);
  assert.match(controls, /<SettingsSelect\s+label="Chat theme"/);
  assert.match(controls, /<SettingsSwitch/);
  assert.match(controls, /type="button" className="app-button-quiet app-settings-action-button/);
  assert.match(controls, /type="button" className="app-input-shell app-settings-control/);
  assert.match(layout, /app-settings-select[^\n]*appearance-none[^\n]*bg-transparent/);
  assert.match(layout, /<ChevronDown aria-hidden="true"/);
});

test('notification settings use titled row sections with contained switches', () => {
  const notifications = readSource('features/notifications/NotificationSettingsPanel.tsx');
  const layout = readSource('kordi-app/components/settingsLayout.tsx');

  assert.match(notifications, /<SettingsSection title="Notification access">/);
  assert.match(notifications, /<SettingsSection title="Preferences">/);
  assert.match(notifications, /<SettingsSwitch/);
  assert.doesNotMatch(notifications, /\buppercase\b/);
  assert.match(layout, /role="switch"/);
  assert.match(layout, /absolute left-0\.5 top-0\.5/);
  assert.match(layout, /enabled \? 'translate-x-\[18px\]' : 'translate-x-0'/);
  assert.match(layout, /focus-visible:ring-\[var\(--app-quiet-control-focus-ring\)\]/);
});

test('dense provider feedback follows the pointer without a transition trail', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /\.app-auth-settings-page \.app-auth-provider-row\s*\{[\s\S]*?transition:\s*none;/);
  assert.match(shellCss, /\.app-auth-settings-page \.app-auth-provider-row::before\s*\{[\s\S]*?transition:\s*none;/);
  assert.match(shellCss, /\.app-auth-settings-page \.app-auth-provider-glyph,[\s\S]*?\.app-auth-settings-page \.app-auth-provider-chevron\s*\{[\s\S]*?transition:\s*none;/);
});

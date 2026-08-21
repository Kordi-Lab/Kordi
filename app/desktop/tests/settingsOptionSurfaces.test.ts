import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readDesktopShellCss } from './helpers/readDesktopStyles';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

test('settings pages render options without card shells or divider boundaries', () => {
  const settingsPage = readSource('pages/SettingsPage.tsx');
  const cloudSettings = readSource('pages/CloudAccountSettingsDialog.tsx');
  const shellCss = readDesktopShellCss();

  assert.match(settingsPage, /app-settings-profile-section/);
  assert.match(settingsPage, /app-settings-option-list/);
  assert.match(settingsPage, /app-settings-option-row/);
  assert.doesNotMatch(settingsPage, /app-surface-muted app-settings-surface/);
  assert.doesNotMatch(settingsPage, /border-t border-white\/10/);

  assert.match(cloudSettings, /app-cloud-account-theme app-settings-option-list/);
  assert.match(cloudSettings, /app-settings-option-row/);
  assert.doesNotMatch(cloudSettings, /app-cloud-account-settings-divider border-t/);
  assert.doesNotMatch(cloudSettings, /app-cloud-account-settings-meta-row[^\n]*border-t/);

  assert.match(shellCss, /\.app-settings-profile-section,[\s\S]*?\.app-settings-option-row\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/);
  assert.match(shellCss, /\.app-settings-option-list\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*2px;/);
});

test('settings navigation is quiet at rest and accessible in both settings surfaces', () => {
  const settingsPage = readSource('pages/SettingsPage.tsx');
  const cloudSettings = readSource('pages/CloudAccountSettingsDialog.tsx');
  const shellCss = readDesktopShellCss();

  for (const source of [settingsPage, cloudSettings]) {
    assert.match(source, /app-settings-nav-item/);
    assert.match(source, /app-settings-nav-item-active/);
    assert.match(source, /aria-current=\{active \? 'page' : undefined\}/);
    assert.doesNotMatch(source, /app-list-item-active/);
  }

  assert.doesNotMatch(settingsPage, /place-items-center rounded-\[10px\] border/);
  assert.match(shellCss, /\.app-settings-nav-item\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;[\s\S]*?transition:\s*none;/);
  assert.match(shellCss, /\.app-settings-nav-item:hover\s*\{[\s\S]*?background:\s*var\(--app-quiet-control-hover-bg\)/);
  assert.match(shellCss, /\.app-settings-nav-item:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--app-quiet-control-focus-ring\)/);
  assert.match(shellCss, /\.app-settings-nav-item::before\s*\{[\s\S]*?width:\s*2px;[\s\S]*?opacity:\s*0;/);
  assert.match(shellCss, /\.app-settings-nav-item-active::before\s*\{[\s\S]*?opacity:\s*0\.72;/);
});

test('setting controls keep containment while theme choices only fill on hover', () => {
  const controls = readSource('kordi-app/components/settings.tsx');

  assert.match(controls, /app-settings-theme-option[^\n]*bg-transparent[^\n]*hover:bg-white\/\[0\.04\]/);
  assert.match(controls, /app-settings-theme-option[^\n]*transition-none/);
  assert.match(controls, /app-settings-theme-preview[^']*transition-none/);
  assert.match(controls, /mode: 'auto', label: 'System'/);
  assert.match(controls, /app-settings-theme-preview[^']*h-24/);
  assert.doesNotMatch(controls, /selected \? 'bg-emerald-400\/10'/);
  assert.match(controls, /app-settings-toggle/);
  assert.match(controls, /app-input-shell app-settings-control/);
  assert.match(controls, /selected \? 'border-emerald-300\/85 ring-2/);
  assert.match(controls, /type="button" className="app-button-quiet app-settings-action-button/);
  assert.match(controls, /type="button" className="app-input-shell app-settings-control/);
});

test('notification settings keep switches contained in a grouped responsive column', () => {
  const notifications = readSource('features/notifications/NotificationSettingsPanel.tsx');

  assert.match(notifications, /max-w-\[620px\]/);
  assert.match(notifications, /border-y border-\[color:var\(--app-divider\)\]/);
  assert.match(notifications, /divide-y divide-\[color:var\(--app-divider\)\]/);
  assert.match(notifications, /absolute left-0\.5 top-0\.5/);
  assert.match(notifications, /enabled \? 'translate-x-\[18px\]' : 'translate-x-0'/);
  assert.match(notifications, /focus-visible:ring-\[var\(--app-quiet-control-focus-ring\)\]/);
});

test('dense provider feedback follows the pointer without a transition trail', () => {
  const shellCss = readDesktopShellCss();

  assert.match(shellCss, /\.app-auth-settings-page \.app-auth-provider-row\s*\{[\s\S]*?transition:\s*none;/);
  assert.match(shellCss, /\.app-auth-settings-page \.app-auth-provider-row::before\s*\{[\s\S]*?transition:\s*none;/);
  assert.match(shellCss, /\.app-auth-settings-page \.app-auth-provider-glyph,[\s\S]*?\.app-auth-settings-page \.app-auth-provider-chevron\s*\{[\s\S]*?transition:\s*none;/);
});

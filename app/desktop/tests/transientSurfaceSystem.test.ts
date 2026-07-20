import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readSource(path: string) {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
}

const themeTokens = readSource('styles/theme-tokens.css');
const transientCss = readSource('styles/transient-surfaces.css');

test('transient surfaces expose a near-opaque semantic contract for dark and light portals', () => {
  const requiredTokens = [
    'surface-bg',
    'surface-fallback',
    'raised-bg',
    'hover-bg',
    'selected-bg',
    'selected-border',
    'border',
    'divider',
    'text',
    'muted-text',
    'focus-ring',
    'overlay-bg',
    'disabled-bg',
    'danger-bg',
    'danger-text',
    'shadow',
  ];

  for (const token of requiredTokens) {
    assert.equal((themeTokens.match(new RegExp(`--app-transient-${token}:`, 'g')) ?? []).length, 2, `${token} should have dark and light values`);
  }

  assert.match(themeTokens, /--app-transient-surface-bg:\s*rgb\(20 22 27 \/ 0\.985\)/);
  assert.match(themeTokens, /--app-transient-surface-bg:\s*rgb\(252 252 253 \/ 0\.985\)/);
  assert.match(themeTokens, /body\.theme-light/);
  assert.match(themeTokens, /\.app-compact-model-menu-light/);
  assert.match(themeTokens, /\.app-composer-mention-menu-light/);
});

test('shared surface classes own popup, row, state, focus, scroll, and fallback styling', () => {
  assert.match(transientCss, /\.app-transient-surface,[\s\S]*\.app-popover,[\s\S]*\.app-frosted-popover,[\s\S]*\.app-modal-panel/);
  assert.match(transientCss, /background:\s*var\(--app-transient-surface-fallback\) !important/);
  assert.match(transientCss, /background:\s*var\(--app-transient-surface-bg\) !important/);
  assert.match(transientCss, /\.app-transient-row-selected/);
  assert.match(transientCss, /\.app-transient-row-danger/);
  assert.match(transientCss, /\.app-transient-scroll/);
  assert.match(transientCss, /:focus-visible/);
  assert.match(transientCss, /@media \(forced-colors: active\)/);

  const indexCss = readSource('index.css');
  assert.ok(indexCss.indexOf("theme-overrides.css") < indexCss.indexOf("transient-surfaces.css"), 'shared contract should be the final style layer');
});

test('representative popup families opt into the shared transient contract', () => {
  const surfaceInventory: Array<[string, RegExp]> = [
    ['pages/ChatCreateDialog.tsx', /app-transient-surface app-frosted-popover app-chat-create-popover/],
    ['components/ui/dialog.tsx', /app-transient-surface app-frosted-popover app-dialog-popover/],
    ['pages/SessionActionOverlays.tsx', /app-transient-surface app-modal-panel/],
    ['kordi-app/components/composer.tsx', /app-transient-surface app-transient-scroll app-compact-model-menu/],
    ['kordi-app/components/transcript.tsx', /app-transient-surface overflow-hidden rounded-\[14px\]/],
    ['pages/MessageForwardDialog.tsx', /app-transient-surface app-message-forward-dialog/],
    ['pages/WorkspaceSidebar.tsx', /app-transient-surface app-popover app-update-popover/],
    ['pages/GroupDetailsDialog.tsx', /app-transient-surface app-frosted-popover app-group-management-popover/],
    ['pages/CloudAccountSettingsDialog.tsx', /app-transient-surface app-modal-panel app-cloud-account-settings-dialog/],
    ['AuthPopup.tsx', /app-transient-surface app-auth-popup-panel app-modal-panel/],
    ['kordi-app/agents/AgentCreateDialog.tsx', /app-transient-surface app-agent-create-dialog/],
    ['kordi-app/agents/AgentDetailPane.tsx', /<AppDialog[\s\S]{0,180}titleId="delete-agent-dialog-title"/],
    ['pages/bridge/BridgeConfigModals.tsx', /app-transient-surface app-modal-panel/],
    ['features/cloud/CloudContactsPanel.tsx', /app-transient-surface w-full/],
    ['features/cloud/CloudPeerChatPanel.tsx', /app-transient-surface app-frosted-popover/],
    ['pages/ArtifactInspector.tsx', /app-transient-surface app-artifact-preview-window-panel/],
    ['kordi-app/components/transcriptAttachments.tsx', /app-transient-surface fixed z-\[230\]/],
  ];

  for (const [path, contract] of surfaceInventory) {
    assert.match(readSource(path), contract, `${path} should use the shared surface`);
  }
});

test('legacy one-off popup shells no longer bypass the semantic palette', () => {
  const popovers = readSource('styles/shell-popovers.css');
  const overrides = readSource('styles/theme-overrides.css');
  const transcript = readSource('kordi-app/components/transcript.tsx');
  const pinDialog = readSource('pages/ChatsPage.tsx');

  assert.doesNotMatch(popovers, /--app-compact-model-menu-bg:\s*rgba/);
  assert.doesNotMatch(popovers, /--app-composer-mention-menu-bg:\s*rgb/);
  assert.doesNotMatch(overrides, /app-profile-popover[\s\S]{0,180}rgba\(20, 24, 32, 0\.56\)/);
  assert.doesNotMatch(transcript, /app-message-context-menu-content[\s\S]{0,220}rounded-\[14px\] bg-white/);
  assert.doesNotMatch(pinDialog, /data-pin-message-dialog[\s\S]{0,180}rounded-\[16px\] bg-white/);
});

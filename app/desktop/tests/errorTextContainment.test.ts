import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readSource = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const readStyle = (path: string) => readSource(`styles/${path}`);

test('app error text has a shared containment utility for long provider/API strings', () => {
  const baseCss = readStyle('base.css');
  const rule = baseCss.match(/:where\(\.app-error-text[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(rule, /min-width:\s*0;/);
  assert.match(rule, /max-width:\s*100%;/);
  assert.match(rule, /overflow-wrap:\s*anywhere;/);
  assert.match(rule, /word-break:\s*break-word;/);
});

test('auth provider detail error uses the shared contained error text class', () => {
  const source = readSource('kordi-app/auth/AuthProviderDetail.tsx');

  assert.match(source, /error && \([\s\S]*app-error-text[\s\S]*\{error\}/);
});

test('common app error surfaces opt into contained error text', () => {
  const sources = [
    'AuthPopup.tsx',
    'pages/ArtifactInspector.tsx',
    'pages/CloudAccountSettingsDialog.tsx',
    'pages/SessionActionOverlays.tsx',
    'pages/WorkspaceSidebar.tsx',
    'features/cloud/CloudContactsPanel.tsx',
    'features/cloud/CloudPeerChatPanel.tsx',
    'kordi-app/auth/LmStudioModelControlCenter.tsx',
    'kordi-app/auth/OllamaModelControlCenter.tsx',
    'kordi-app/auth/LocalProviderSetup.tsx',
    'kordi-app/agents/AgentCreateDialog.tsx',
    'kordi-app/agents/AgentDetailPane.tsx',
    'kordi-app/components/EditableIdentityAvatar.tsx',
    'kordi-app/components/transcriptAttachmentActions.tsx',
    'kordi-app/pages.tsx',
  ];

  for (const path of sources) {
    assert.match(readSource(path), /app-error-text/, `${path} should contain long error text inside its box`);
  }
});

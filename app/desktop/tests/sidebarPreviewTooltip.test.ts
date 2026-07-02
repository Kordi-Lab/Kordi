import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const sidebarSource = () => readFileSync(new URL('../src/pages/WorkspaceSidebar.tsx', import.meta.url), 'utf8');

test('sidebar preview rows do not expose full message previews as native hover tooltips', () => {
  const source = sidebarSource();
  assert.doesNotMatch(source, /title=\{sessionPreviewLine\}/, 'participant-space session previews should not show full native tooltips');
  assert.doesNotMatch(source, /title=\{space\.preview\}/, 'participant-space previews should not show full native tooltips');
  assert.doesNotMatch(source, /title=\{subtitleLine\}/, 'chat session subtitles should not show full native tooltips');
});

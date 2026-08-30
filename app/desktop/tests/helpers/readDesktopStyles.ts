import { readFileSync } from 'node:fs';

const SHELL_STYLE_FILES = [
  '../../src/styles/shell.css',
  '../../src/styles/shell-contacts.css',
  '../../src/styles/shell-navigation.css',
  '../../src/styles/shell-composer.css',
  '../../src/styles/shell-inspector.css',
  '../../src/styles/shell-glass.css',
  '../../src/styles/shell-popovers.css',
  '../../src/styles/shell-bubbles.css',
  '../../src/styles/shell-transcript-motion.css',
  '../../src/styles/shell-transcript.css',
  '../../src/styles/shell-transcript-timeline.css',
  '../../src/styles/shell-message-actions.css',
  '../../src/styles/shell-live-answer.css',
  '../../src/styles/shell-diff.css',
  '../../src/styles/shell-sidebar.css',
  '../../src/styles/shell-pages.css',
  '../../src/styles/shell-factory-foundation.css',
  '../../src/styles/shell-factory-rail.css',
  '../../src/styles/shell-factory-skills.css',
  '../../src/styles/shell-factory-community.css',
  '../../src/styles/shell-factory-conversation.css',
  '../../src/styles/shell-factory-routes.css',
  '../../src/styles/shell-factory-composer.css',
  '../../src/styles/shell-factory-capabilities.css',
  '../../src/styles/shell-factory-files.css',
  '../../src/styles/shell-factory-overlays.css',
  '../../src/styles/theme-overrides.css',
  '../../src/styles/theme-shell-controls.css',
  '../../src/styles/theme-auth-controls.css',
  '../../src/styles/theme-auth-gate.css',
  '../../src/styles/transient-surfaces.css',
] as const;

export function readDesktopShellCss() {
  return SHELL_STYLE_FILES
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
}

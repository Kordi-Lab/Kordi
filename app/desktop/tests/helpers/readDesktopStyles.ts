import { readFileSync } from 'node:fs';

const SHELL_STYLE_FILES = [
  '../../src/styles/shell.css',
  '../../src/styles/shell-popovers.css',
  '../../src/styles/shell-bubbles.css',
  '../../src/styles/shell-transcript.css',
  '../../src/styles/shell-sidebar.css',
  '../../src/styles/shell-pages.css',
  '../../src/styles/theme-overrides.css',
  '../../src/styles/transient-surfaces.css',
] as const;

export function readDesktopShellCss() {
  return SHELL_STYLE_FILES
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
}

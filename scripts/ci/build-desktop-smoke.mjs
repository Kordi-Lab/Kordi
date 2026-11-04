import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../..', import.meta.url));
if (process.argv.length !== 2) throw new Error('The CI smoke build does not accept overrides.');
const temporary = mkdtempSync(path.join(tmpdir(), 'kordi-ci-desktop-smoke-'));
try {
  copyFileSync(new URL('./desktop-smoke-profile.json', import.meta.url), path.join(temporary, 'profile.json'));
  // Use valid public development artwork; contract-test icons are intentionally minimal.
  for (const extension of ['png', 'icns']) {
    copyFileSync(path.join(root, `app/desktop/src-tauri/icons/icon-dev.${extension}`),
      path.join(temporary, `icon.${extension}`));
  }
  const env = { ...process.env };
  // This synthetic build must not inherit an operator profile or release credentials.
  for (const key of Object.keys(env)) {
    if (/^(APPLE_|TAURI_|KORDI_|VITE_|CI_SMOKE_)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    KORDI_DISTRIBUTION_PROFILE: path.join(temporary, 'profile.json'),
    KORDI_EXPECTED_EDITION: 'app',
    KORDI_EXPECTED_ENVIRONMENT: 'staging',
    KORDI_EXPECTED_BACKEND_ORIGIN: 'https://desktop-smoke.example.test',
  });
  const result = spawnSync('pnpm', ['--dir', 'app/desktop', 'tauri:build:cloud', '--unsigned', '--bundles', 'app'],
    { cwd: root, env, stdio: 'inherit', shell: false });
  if (result.error) console.error('Unable to start the desktop smoke build.');
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { distributionFromEnvironment, writeDistributionArtifacts } from '../shared/configuration/distribution-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [platform, ...args] = process.argv.slice(2);
let temporary;
let copiedIcon;
try {
  if (!['desktop', 'ios'].includes(platform)) throw new Error('Select desktop or ios.');
  if (args.some((arg) => !['--build', '--unsigned', '--acceptance', '--bootstrap', '--bundles', 'app,dmg', 'app', 'dmg'].includes(arg))) throw new Error('Unsupported packaging option.');
  const selection = distributionFromEnvironment();
  const { profile } = selection;
  temporary = mkdtempSync(path.join(tmpdir(), 'kordi-distribution-'));
  const prepared = writeDistributionArtifacts(selection, path.join(temporary, 'prepared'));
  const build = args.includes('--build');
  const unsigned = args.includes('--unsigned');
  const env = { ...process.env,
    KORDI_DISTRIBUTION_PROFILE: path.join(prepared, 'profile.json'),
    KORDI_RELEASE_BACKEND_ORIGIN: profile.routing.backend.origin,
    VITE_KORDI_CLOUD_API_BASE: profile.routing.backend.origin,
    MACOSX_DEPLOYMENT_TARGET: '13.0',
    CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER: path.join(root, 'scripts/macos-proc-macro-linker.sh'),
  };
  // Planning never reads signing values or touches Keychain. Secrets are resolved only for an explicit build.
  if (!build) {
    console.log(JSON.stringify({ platform, edition: profile.routing.edition, origin: profile.routing.backend.origin,
      identifier: platform === 'ios' ? profile.clients.iosIdentifier : profile.clients.desktopIdentifier,
      signed: !unsigned, signingBindings: profile.apple, updatesEnabled: profile.clients.updates.enabled,
      action: 'validate-only; no build, signing, upload or deployment' }, null, 2));
  } else {
    const run = (command, arguments_, cwd) => {
      const result = spawnSync(command, arguments_, { cwd, env, stdio: 'inherit', shell: false });
      if (result.status !== 0) throw new Error('Packaging command failed.');
    };
    const binding = (name) => {
      const value = process.env[name];
      if (!value || /[\r\n\0]/.test(value)) throw new Error('A required external signing binding is missing.');
      return value;
    };
    if (platform === 'desktop') {
      const overlay = path.join(prepared, 'tauri.json');
      const config = JSON.parse(readFileSync(overlay, 'utf8'));
      if (args.includes('--acceptance') && profile.clients.updates.enabled) {
        config.plugins.updater.endpoints = [`${profile.routing.backend.origin}/updates/desktop/acceptance/{{target}}/{{arch}}/{{current_version}}`];
      }
      if (args.includes('--bootstrap')) {
        if (!args.includes('--acceptance')) throw new Error('Bootstrap requires acceptance packaging.');
        config.version = '0.0.1-beta.5.1';
      }
      config.bundle.macOS = { signingIdentity: unsigned ? '-' : binding(profile.apple.identityBinding) };
      if (!unsigned) env.APPLE_TEAM_ID = binding(profile.apple.teamBinding);
      // Native signing and notarization credentials continue to use the standard Tauri environment/Keychain path.
      // No key values are written to the generated overlay or printed.
      writeFileSync(overlay, JSON.stringify(config));
      const cwd = path.join(root, 'app/desktop');
      run('pnpm', ['release:secret-guard'], cwd);
      run('pnpm', ['tauri:prepare-sidecars'], cwd);
      const bundlesAt = args.indexOf('--bundles');
      const bundles = bundlesAt >= 0 ? args[bundlesAt + 1] : 'app,dmg';
      if (!['app,dmg', 'app', 'dmg'].includes(bundles)) throw new Error('Invalid bundle selection.');
      run('pnpm', ['exec', 'tauri', 'build', '--config', 'src-tauri/.tauri-dev/omp-sidecars.json', '--config', overlay, '--bundles', bundles], cwd);
    } else {
      const iconDestination = path.join(root, 'app/ios/Distribution.xcassets/DistributionIcon.appiconset');
      // Exclusive directory creation prevents replacing another task's prepared artwork.
      const { mkdirSync } = await import('node:fs');
      mkdirSync(iconDestination);
      copiedIcon = iconDestination;
      cpSync(path.join(prepared, 'Distribution.xcassets/DistributionIcon.appiconset'), copiedIcon, { recursive: true });
      const scheme = profile.routing.edition === 'research' ? 'Kordi Research' : 'Kordi';
      const config = profile.routing.edition === 'research' ? 'Research' : 'Release';
      const signing = unsigned ? ['CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO']
        : [`DEVELOPMENT_TEAM=${binding(profile.apple.teamBinding)}`];
      run('xcodebuild', ['-project', 'app/ios/Kordi.xcodeproj', '-scheme', scheme, '-configuration', config,
        '-xcconfig', path.join(prepared, 'ios.xcconfig'), '-destination', unsigned ? 'generic/platform=iOS Simulator' : 'generic/platform=iOS',
        '-derivedDataPath', path.join(root, '.build', `ios-${profile.routing.edition}`),
        ...signing, 'build'], root);
    }
  }
} catch (error) {
  console.error(error instanceof Error && /^[A-Za-z ;,.-]+$/.test(error.message) ? error.message : 'Distribution packaging failed. Check the profile and external bindings.');
  process.exitCode = 1;
} finally {
  if (copiedIcon) rmSync(copiedIcon, { recursive: true, force: true });
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}

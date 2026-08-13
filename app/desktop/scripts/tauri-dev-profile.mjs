import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  buildBeforeDevCommand,
  resolveDesktopPreviewIcons,
} from './tauri-dev-env.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, '..');
const tauriConfigPath = join(appRoot, 'src-tauri', 'tauri.conf.json');
const tauriBin = join(
  appRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri'
);

function printHelp() {
  console.log(`
Usage:
  pnpm --dir app/desktop tauri:dev:profile -- --port 1422 --profile feature-b

Options:
  --port <number>          Dev server port. Default: 1420
  --host <host>            Dev server host. Default: 127.0.0.1
  --profile <name>         Profile label used for app title + Cloud identifier suffix.
  --title <name>           Custom window/app title.
  --identifier <value>     Full isolated Cloud identifier override (io.kordi.cloud.*).
  --dry-run                Print the generated Tauri config and exit.
  --help                   Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    port: '1420',
    host: '127.0.0.1',
    profile: 'dev',
    title: null,
    identifier: null,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--port' || arg === '--host' || arg === '--profile' || arg === '--title' || arg === '--identifier') {
      const value = argv[index + 1];
      if (!value) {
        console.error(`[kordi] Missing value for ${arg}`);
        process.exit(1);
      }
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }

    console.error(`[kordi] Unknown argument: ${arg}`);
    printHelp();
    process.exit(1);
  }

  return options;
}

function sanitizeIdentifierPart(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-');
}

function isCloudIdentifier(value) {
  return value.startsWith('io.kordi.cloud.') && value.length > 'io.kordi.cloud.'.length;
}

function ensureTauriCli() {
  if (!existsSync(tauriBin)) {
    console.error(`[kordi] Missing Tauri CLI at ${tauriBin}. Run install first.`);
    process.exit(1);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const options = parseArgs(process.argv.slice(2));
const port = Number.parseInt(options.port, 10);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[kordi] Invalid port: ${options.port}`);
  process.exit(1);
}

const profileKey = sanitizeIdentifierPart(options.profile || 'dev') || 'dev';
const title = options.title || `Kordi (${options.profile})`;
const identifier = options.identifier || `io.kordi.cloud.${profileKey}`;
if (!isCloudIdentifier(identifier)) {
  console.error(
    '[kordi] Isolated profiles must use a unique io.kordi.cloud.* identifier '
    + 'so they cannot reuse the production app data directory.',
  );
  console.error(`[kordi] Received identifier: ${identifier}`);
  process.exit(1);
}
const devUrl = `http://${options.host}:${port}`;
const beforeDevCommand = buildBeforeDevCommand({
  title,
  host: options.host,
  port,
});

const baseConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
const nextConfig = {
  ...baseConfig,
  productName: title,
  identifier,
  bundle: {
    ...baseConfig.bundle,
    createUpdaterArtifacts: false,
    icon: resolveDesktopPreviewIcons(process.env),
  },
  build: {
    ...baseConfig.build,
    beforeDevCommand,
    devUrl,
  },
  app: {
    ...baseConfig.app,
    windows: (baseConfig.app?.windows ?? []).map((window, index) => (
      index === 0
        ? { ...window, title }
        : window
    )),
  },
  plugins: {
    ...baseConfig.plugins,
    updater: {
      ...baseConfig.plugins?.updater,
      endpoints: [],
    },
  },
};

const generatedConfigDir = join(appRoot, 'src-tauri', '.tauri-dev');
const generatedConfigPath = join(generatedConfigDir, `${profileKey}-${port}.json`);
mkdirSync(generatedConfigDir, { recursive: true });
writeFileSync(generatedConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`);

if (options.dryRun) {
  console.log(`[kordi] Generated config: ${generatedConfigPath}`);
  console.log(JSON.stringify(nextConfig, null, 2));
  process.exit(0);
}

ensureTauriCli();
console.log(`[kordi] Starting profile "${options.profile}" at ${devUrl}`);
console.log(`[kordi] App identifier: ${identifier}`);
console.log(`[kordi] Generated config: ${generatedConfigPath}`);

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'tauri:prepare-sidecars']);
run(tauriBin, ['dev', '--config', generatedConfigPath]);

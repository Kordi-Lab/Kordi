import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, '..');
const profileScript = join(__dirname, 'tauri-dev-profile.mjs');

function printHelp() {
  console.log(`
Usage:
  pnpm --dir app/desktop tauri:dev:instance -- --instance user1 --port 1426

Options:
  --instance <id>         Logical instance/user id. Required.
  --port <number>         Dev server port. Default: 1420
  --host <host>           Dev server host. Default: 127.0.0.1
  --profile <name>        Tauri profile label. Defaults to instance id.
  --title <name>          Window title. Defaults to Kordi (<instance>)
  --data-dir <path>       Root directory for isolated instance data.
                          Default: app/desktop/.multi-instance-data/<instance>
  KORDI_AUTH_PATH=<path>  Optional env override for a shared auth.json path.
  --clean                 Remove the target data dir before launch.
  --dry-run               Print the env/config that would be used and exit.
  --help                  Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    instance: '',
    port: '1420',
    host: '127.0.0.1',
    profile: '',
    title: '',
    dataDir: '',
    clean: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--clean') {
      options.clean = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (['--instance', '--port', '--host', '--profile', '--title', '--data-dir'].includes(arg)) {
      const value = argv[index + 1];
      if (!value) {
        console.error(`[kordi] Missing value for ${arg}`);
        process.exit(1);
      }
      const key = arg === '--data-dir' ? 'dataDir' : arg.slice(2);
      options[key] = value;
      index += 1;
      continue;
    }

    console.error(`[kordi] Unknown argument: ${arg}`);
    printHelp();
    process.exit(1);
  }

  if (!options.instance.trim()) {
    console.error('[kordi] --instance is required');
    printHelp();
    process.exit(1);
  }

  return options;
}

function sanitizeSegment(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'instance';
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    stdio: 'inherit',
    env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const options = parseArgs(process.argv.slice(2));
const instanceId = sanitizeSegment(options.instance);
const profile = options.profile || instanceId;
const title = options.title || `Kordi (${instanceId})`;
const dataDir = resolve(options.dataDir || join(appRoot, '.multi-instance-data', instanceId));
const port = Number.parseInt(options.port, 10);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[kordi] Invalid port: ${options.port}`);
  process.exit(1);
}

if (!existsSync(profileScript)) {
  console.error(`[kordi] Missing profile helper at ${profileScript}`);
  process.exit(1);
}

if (options.clean && existsSync(dataDir)) {
  rmSync(dataDir, { recursive: true, force: true });
}
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(dataDir, 'tmp'), { recursive: true });
mkdirSync(join(dataDir, 'bridges-projects'), { recursive: true });

const env = {
  ...process.env,
  APP_INSTANCE_ID: instanceId,
  APP_DATA_DIR: dataDir,
  APP_PROFILE: profile,
  APP_PORT: `${port}`,
  KORDI_STORAGE_ROOT: join(dataDir, 'kordi'),
  BRIDGES_HOME: join(dataDir, 'bridges'),
  BRIDGES_PROJECTS_DIR: join(dataDir, 'bridges-projects'),
};

const forwardedArgs = [
  profileScript,
  '--port',
  `${port}`,
  '--host',
  options.host,
  '--profile',
  profile,
  '--title',
  title,
];

if (options.dryRun) forwardedArgs.push('--dry-run');

console.log(`[kordi] Instance id: ${instanceId}`);
console.log(`[kordi] Data dir: ${dataDir}`);
console.log(`[kordi] Profile: ${profile}`);
console.log(`[kordi] Port: ${port}`);
console.log(`[kordi] KORDI_STORAGE_ROOT=${env.KORDI_STORAGE_ROOT}`);
if (env.KORDI_AUTH_PATH) {
  console.log(`[kordi] KORDI_AUTH_PATH=${env.KORDI_AUTH_PATH}`);
}
console.log(`[kordi] BRIDGES_HOME=${env.BRIDGES_HOME}`);
console.log(`[kordi] BRIDGES_PROJECTS_DIR=${env.BRIDGES_PROJECTS_DIR}`);

run(process.execPath, forwardedArgs, env);

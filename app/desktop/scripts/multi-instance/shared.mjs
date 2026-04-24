import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const appRoot = resolve(__dirname, '..', '..');
export const configRoot = resolve(__dirname, 'configs');
export const defaultConfigPath = resolve(configRoot, 'users.yaml');
export const tauriDevInstanceScript = resolve(appRoot, 'scripts', 'tauri-dev-instance.mjs');

export function printCommonHelp({ command }) {
  console.log(`
Usage:
  pnpm --dir app/desktop ${command} -- --users user1,user2

Options:
  --config <path>         Config file path. Default: app/desktop/scripts/multi-instance/configs/users.yaml
  --users <ids>           Comma-separated user ids to include. Default: all configured users.
  --reset                 Stop matching launched instances and remove their data/logs before continuing.
  --dry-run               Print the resolved plan and exit.
  --help                  Show this help.
`);
}

export function parseCommonArgs(argv, { command }) {
  const options = {
    configPath: defaultConfigPath,
    userIds: [],
    reset: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      printCommonHelp({ command });
      process.exit(0);
    }
    if (arg === '--reset') {
      options.reset = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--config' || arg === '--users') {
      const value = argv[index + 1];
      if (!value) {
        console.error(`[kordi] Missing value for ${arg}`);
        process.exit(1);
      }
      if (arg === '--config') {
        options.configPath = resolve(process.cwd(), value);
      } else {
        options.userIds = value
          .split(',')
          .map((item) => sanitizeSegment(item))
          .filter(Boolean);
      }
      index += 1;
      continue;
    }

    console.error(`[kordi] Unknown argument: ${arg}`);
    printCommonHelp({ command });
    process.exit(1);
  }

  return options;
}

export function sanitizeSegment(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || '';
}

function resolveMaybeRelative(baseDir, value) {
  if (!value) return null;
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function ensureIntegerPort(value, label) {
  const port = Number.parseInt(`${value}`, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return port;
}

function parseAuthFixtureSummary(authFile) {
  if (!existsSync(authFile)) {
    throw new Error(`Missing bootstrap auth file at ${authFile}`);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(authFile, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid bootstrap auth JSON at ${authFile}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const profiles = raw?.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
  const activeAuthMethods = raw?.active_auth_methods && typeof raw.active_auth_methods === 'object'
    ? raw.active_auth_methods
    : {};

  return {
    providerIds: Object.keys(profiles).sort(),
    profileCounts: Object.fromEntries(
      Object.entries(profiles)
        .map(([providerId, entries]) => [providerId, Array.isArray(entries) ? entries.length : 0])
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    activeMethodProviders: Object.keys(activeAuthMethods).sort(),
  };
}

function findSharedAuthFile() {
  const home = homedir();
  if (!home) {
    throw new Error('Unable to resolve home directory for shared auth bootstrap');
  }

  const candidates = [
    resolve(home, '.kordi', 'auth.json'),
    resolve(home, '.bb-agent', 'auth.json'),
  ];

  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(`Shared auth store not found. Checked: ${candidates.join(', ')}`);
  }

  return match;
}

function resolveBootstrap(configDir, defaultsBootstrap, userBootstrap, dataDir) {
  const bootstrap = {
    ...(defaultsBootstrap && typeof defaultsBootstrap === 'object' ? defaultsBootstrap : {}),
    ...(userBootstrap && typeof userBootstrap === 'object' ? userBootstrap : {}),
  };

  const authMode = `${bootstrap.authMode ?? bootstrap.mode ?? 'if-missing'}`;
  if (!['if-missing', 'always'].includes(authMode)) {
    throw new Error(`Invalid bootstrap authMode: ${authMode}`);
  }

  if (bootstrap.authFile && bootstrap.authSource) {
    throw new Error('Configure only one of bootstrap.authFile or bootstrap.authSource');
  }

  const authSource = bootstrap.authSource ? `${bootstrap.authSource}`.trim().toLowerCase() : '';
  const authFile = bootstrap.authFile
    ? resolveMaybeRelative(configDir, bootstrap.authFile)
    : authSource === 'shared'
      ? findSharedAuthFile()
      : null;

  if (authSource && authSource !== 'shared') {
    throw new Error(`Invalid bootstrap authSource: ${bootstrap.authSource}`);
  }

  if (!authFile) {
    return null;
  }

  return {
    authSource: authSource || 'file',
    authFile,
    authMode,
    authTargetPath: resolve(dataDir, 'kordi', 'auth.json'),
    authSummary: parseAuthFixtureSummary(authFile),
  };
}

export function loadMultiInstanceConfig(configPath, selectedUserIds = []) {
  if (!existsSync(configPath)) {
    throw new Error(`Missing multi-instance config at ${configPath}`);
  }

  const raw = YAML.parse(readFileSync(configPath, 'utf8'));
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid multi-instance config in ${configPath}`);
  }

  const configDir = dirname(configPath);
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  const users = Array.isArray(raw.users) ? raw.users : [];

  if (users.length === 0) {
    throw new Error(`No users configured in ${configPath}`);
  }

  const dataRoot = resolveMaybeRelative(configDir, defaults.dataRoot) ?? resolve(appRoot, '.multi-instance-data');
  const logsRoot = resolveMaybeRelative(configDir, defaults.logsRoot) ?? resolve(appRoot, '.multi-instance-logs');
  const runtimeRoot = resolveMaybeRelative(configDir, defaults.runtimeRoot) ?? resolve(appRoot, '.multi-instance-runtime');
  const defaultHost = `${defaults.host ?? '127.0.0.1'}`;
  const defaultTitlePrefix = `${defaults.titlePrefix ?? 'Kordi'}`;
  const defaultsBootstrap = defaults.bootstrap && typeof defaults.bootstrap === 'object' ? defaults.bootstrap : null;

  const resolvedUsers = users.map((user, index) => {
    if (!user || typeof user !== 'object') {
      throw new Error(`Invalid user entry at users[${index}]`);
    }

    const id = sanitizeSegment(`${user.id ?? ''}`);
    if (!id) {
      throw new Error(`User at index ${index} is missing a valid id`);
    }

    const port = ensureIntegerPort(user.port, `port for ${id}`);
    const host = `${user.host ?? defaultHost}`;
    const profile = sanitizeSegment(`${user.profile ?? id}`) || id;
    const title = `${user.title ?? `${defaultTitlePrefix} (${id})`}`;
    const dataDir = resolveMaybeRelative(configDir, user.dataDir) ?? resolve(dataRoot, id);
    const logDir = resolve(logsRoot, id);
    const logFile = resolve(logDir, `dev-${port}.log`);
    const pidFile = resolve(runtimeRoot, `${id}.pid`);
    const metaFile = resolve(runtimeRoot, `${id}.json`);
    const bootstrap = resolveBootstrap(configDir, defaultsBootstrap, user.bootstrap, dataDir);

    return {
      id,
      host,
      port,
      profile,
      title,
      dataDir,
      logDir,
      logFile,
      pidFile,
      metaFile,
      cleanOnLaunch: Boolean(user.cleanOnLaunch),
      bootstrap,
    };
  });

  const seenIds = new Set();
  const seenPorts = new Set();
  for (const user of resolvedUsers) {
    if (seenIds.has(user.id)) {
      throw new Error(`Duplicate user id in config: ${user.id}`);
    }
    if (seenPorts.has(user.port)) {
      throw new Error(`Duplicate port in config: ${user.port}`);
    }
    seenIds.add(user.id);
    seenPorts.add(user.port);
  }

  const filteredUsers = selectedUserIds.length > 0
    ? resolvedUsers.filter((user) => selectedUserIds.includes(user.id))
    : resolvedUsers;

  if (filteredUsers.length === 0) {
    throw new Error(`No configured users matched: ${selectedUserIds.join(', ')}`);
  }

  return {
    configPath,
    dataRoot,
    logsRoot,
    runtimeRoot,
    users: filteredUsers,
  };
}

export function ensureMultiInstanceDirs(config) {
  mkdirSync(config.dataRoot, { recursive: true });
  mkdirSync(config.logsRoot, { recursive: true });
  mkdirSync(config.runtimeRoot, { recursive: true });
}

export function removeInstanceArtifacts(instance) {
  rmSync(instance.dataDir, { recursive: true, force: true });
  rmSync(instance.logDir, { recursive: true, force: true });
  rmSync(instance.pidFile, { force: true });
  rmSync(instance.metaFile, { force: true });
}

export function applyBootstrap(instance, { force = false } = {}) {
  if (!instance.bootstrap?.authFile) {
    return { id: instance.id, seeded: false, reason: 'no-bootstrap-configured' };
  }

  const authTargetPath = instance.bootstrap.authTargetPath;
  const shouldSeed = force || instance.bootstrap.authMode === 'always' || !existsSync(authTargetPath);

  if (!shouldSeed) {
    return { id: instance.id, seeded: false, reason: 'existing-auth-preserved' };
  }

  mkdirSync(dirname(authTargetPath), { recursive: true });
  copyFileSync(instance.bootstrap.authFile, authTargetPath);

  return {
    id: instance.id,
    seeded: true,
    reason: force ? 'forced-bootstrap' : instance.bootstrap.authMode,
    authTargetPath,
    authSummary: instance.bootstrap.authSummary,
  };
}

export function writeInstanceMetadata(instance, extra = {}) {
  writeFileSync(instance.pidFile, `${extra.pid ?? ''}\n`);
  writeFileSync(instance.metaFile, `${JSON.stringify({
    id: instance.id,
    host: instance.host,
    port: instance.port,
    profile: instance.profile,
    title: instance.title,
    dataDir: instance.dataDir,
    logFile: instance.logFile,
    bootstrap: instance.bootstrap
      ? {
          authSource: instance.bootstrap.authSource,
          authFile: instance.bootstrap.authFile,
          authMode: instance.bootstrap.authMode,
          authTargetPath: instance.bootstrap.authTargetPath,
          authSummary: instance.bootstrap.authSummary,
        }
      : null,
    pid: extra.pid ?? null,
    startedAt: extra.startedAt ?? null,
  }, null, 2)}\n`);
}

export function readInstancePid(instance) {
  if (!existsSync(instance.pidFile)) return null;
  const value = readFileSync(instance.pidFile, 'utf8').trim();
  const pid = Number.parseInt(value, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopInstance(instance) {
  const pid = readInstancePid(instance);
  if (!pid || !isPidRunning(pid)) {
    rmSync(instance.pidFile, { force: true });
    rmSync(instance.metaFile, { force: true });
    return { id: instance.id, stopped: false, pid };
  }

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // noop
      }
    }

    await sleep(signal === 'SIGTERM' ? 1200 : 250);
    if (!isPidRunning(pid)) break;
  }

  const stopped = !isPidRunning(pid);
  if (stopped) {
    rmSync(instance.pidFile, { force: true });
    rmSync(instance.metaFile, { force: true });
  }

  return { id: instance.id, stopped, pid };
}

export async function assertPortsAvailable(instances) {
  const unavailable = [];

  for (const instance of instances) {
    const available = await isPortAvailable(instance.port, instance.host);
    if (!available) {
      unavailable.push(instance);
    }
  }

  if (unavailable.length > 0) {
    throw new Error(`Ports already in use: ${unavailable.map((item) => item.port).join(', ')}`);
  }
}

function isPortAvailable(port, host) {
  return new Promise((resolvePromise) => {
    const server = net.createServer();

    server.once('error', () => {
      resolvePromise(false);
    });

    server.once('listening', () => {
      server.close(() => resolvePromise(true));
    });

    server.listen(port, host);
  });
}

export function summarizeConfig(config) {
  return {
    configPath: config.configPath,
    dataRoot: config.dataRoot,
    logsRoot: config.logsRoot,
    runtimeRoot: config.runtimeRoot,
    users: config.users.map((user) => ({
      id: user.id,
      host: user.host,
      port: user.port,
      profile: user.profile,
      title: user.title,
      dataDir: user.dataDir,
      logFile: user.logFile,
      pidFile: user.pidFile,
      cleanOnLaunch: user.cleanOnLaunch,
      bootstrap: user.bootstrap
        ? {
            authSource: user.bootstrap.authSource,
            authFile: user.bootstrap.authFile,
            authMode: user.bootstrap.authMode,
            authSummary: user.bootstrap.authSummary,
          }
        : null,
    })),
  };
}

export function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

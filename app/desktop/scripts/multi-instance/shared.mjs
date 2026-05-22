import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
  --shared-auth           Use the configured shared auth file by path instead of copying it per instance.
  --dry-run               Print the resolved plan and exit.
  --help                  Show this help.
`);
}

export function parseCommonArgs(argv, { command }) {
  const options = {
    configPath: defaultConfigPath,
    userIds: [],
    reset: false,
    sharedAuth: false,
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
    if (arg === '--shared-auth') {
      options.sharedAuth = true;
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

export function parseAuthStoreSummary(authFile) {
  if (!existsSync(authFile)) {
    throw new Error(`Missing auth store at ${authFile}`);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(authFile, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid auth JSON at ${authFile}: ${error instanceof Error ? error.message : String(error)}`);
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
    authSummary: parseAuthStoreSummary(authFile),
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

function sanitizeTauriIdentifierPart(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-') || 'dev';
}

export function tauriProfileArtifactPaths({ profile, homeDir = homedir() }) {
  const identifier = `io.kordi.desktop.${sanitizeTauriIdentifierPart(`${profile ?? 'dev'}`)}`;
  return [
    join(homeDir, 'Library', 'Application Support', identifier),
    join(homeDir, 'Library', 'Caches', identifier),
    join(homeDir, 'Library', 'WebKit', identifier),
    join(homeDir, 'Library', 'HTTPStorages', identifier),
    join(homeDir, 'Library', 'Saved Application State', `${identifier}.savedState`),
    join(homeDir, 'Library', 'Preferences', `${identifier}.plist`),
    join(homeDir, 'Library', 'Cookies', `${identifier}.binarycookies`),
  ];
}

export function removeTauriProfileArtifacts(instance, { homeDir = homedir() } = {}) {
  for (const artifactPath of tauriProfileArtifactPaths({ profile: instance.profile, homeDir })) {
    rmSync(artifactPath, { recursive: true, force: true });
  }
}

export function removeInstanceArtifacts(instance) {
  rmSync(instance.dataDir, { recursive: true, force: true });
  rmSync(instance.logDir, { recursive: true, force: true });
  rmSync(instance.pidFile, { force: true });
  rmSync(instance.metaFile, { force: true });
  removeTauriProfileArtifacts(instance);
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

export function prepareInstanceEnvironment(config, instance, { forceBootstrap = false, skipBootstrap = false } = {}) {
  ensureMultiInstanceDirs({
    ...config,
    dataRoot: instance.dataDir,
    logsRoot: instance.logDir,
    runtimeRoot: config.runtimeRoot,
  });

  if (skipBootstrap) {
    return { id: instance.id, seeded: false, reason: 'shared-auth-path' };
  }

  return applyBootstrap(instance, { force: forceBootstrap });
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

export function launchDetachedInstance(instance, { inheritedEnv = process.env, clean = instance.cleanOnLaunch } = {}) {
  const logFd = openSync(instance.logFile, 'a');
  const startedAt = new Date().toISOString();
  writeSync(logFd, `\n=== ${startedAt} launching ${instance.id} on port ${instance.port} ===\n`);

  const args = [
    tauriDevInstanceScript,
    '--instance',
    instance.id,
    '--port',
    `${instance.port}`,
    '--host',
    instance.host,
    '--profile',
    instance.profile,
    '--title',
    instance.title,
    '--data-dir',
    instance.dataDir,
  ];

  if (clean) {
    args.push('--clean');
  }

  const child = spawn(process.execPath, args, {
    cwd: appRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: inheritedEnv,
  });

  child.unref();

  writeInstanceMetadata(instance, {
    pid: child.pid,
    startedAt,
  });

  return {
    id: instance.id,
    pid: child.pid,
    startedAt,
    logFile: instance.logFile,
  };
}

export function readJsonFile(path) {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function logFileSize(path) {
  if (!existsSync(path)) {
    return 0;
  }
  return statSync(path).size;
}

export function readAuthSummaryFromPath(path) {
  if (!existsSync(path)) {
    return null;
  }
  return parseAuthStoreSummary(path);
}

export function currentInstanceSmokeState(instance) {
  const authPath = instance.bootstrap?.authTargetPath ?? resolve(instance.dataDir, 'kordi', 'auth.json');
  const pid = readInstancePid(instance);
  const meta = readJsonFile(instance.metaFile);
  const authSummary = readAuthSummaryFromPath(authPath);
  const logSize = logFileSize(instance.logFile);
  const logText = existsSync(instance.logFile) ? readFileSync(instance.logFile, 'utf8') : '';

  return {
    id: instance.id,
    pid,
    pidRunning: isPidRunning(pid),
    metaExists: Boolean(meta),
    metaMatches: Boolean(meta && meta.id === instance.id && meta.port === instance.port),
    authPath,
    authExists: existsSync(authPath),
    authSummary,
    logFile: instance.logFile,
    logExists: existsSync(instance.logFile),
    logSize,
    logHasProfileStart: logText.includes('[kordi] Starting profile'),
    logHasGeneratedConfig: logText.includes('[kordi] Generated config:'),
  };
}

export async function waitFor(check, { timeoutMs = 30_000, intervalMs = 500, description = 'condition' } = {}) {
  const startedAt = Date.now();
  let lastResult = null;

  while (Date.now() - startedAt <= timeoutMs) {
    lastResult = await check();
    if (lastResult) {
      return lastResult;
    }
    await sleep(intervalMs);
  }

  const error = new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
  error.lastResult = lastResult;
  throw error;
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

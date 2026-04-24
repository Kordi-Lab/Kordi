import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    })),
  };
}

export function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

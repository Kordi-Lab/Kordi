import { resolve } from 'node:path';

import {
  assertPortsAvailable,
  currentInstanceSmokeState,
  defaultConfigPath,
  ensureMultiInstanceDirs,
  launchDetachedInstance,
  loadMultiInstanceConfig,
  prepareInstanceEnvironment,
  removeInstanceArtifacts,
  sanitizeSegment,
  stopInstance,
  summarizeConfig,
  waitFor,
} from './shared.mjs';

function printHelp() {
  console.log(`
Usage:
  pnpm --dir app/desktop tauri:dev:multi:smoke -- --users user1,user2

Options:
  --config <path>         Config file path. Default: app/desktop/scripts/multi-instance/configs/users.yaml
  --users <ids>           Exactly two comma-separated user ids. Default: first two configured users.
  --timeout-ms <ms>       Max wait time per user. Default: 45000
  --interval-ms <ms>      Poll interval while waiting for readiness. Default: 1000
  --leave-running         Keep verified instances running after the smoke test completes.
  --dry-run               Print the resolved smoke plan and exit.
  --help                  Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    configPath: defaultConfigPath,
    userIds: [],
    timeoutMs: 45_000,
    intervalMs: 1_000,
    leaveRunning: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--leave-running') {
      options.leaveRunning = true;
      continue;
    }

    if (arg === '--config' || arg === '--users' || arg === '--timeout-ms' || arg === '--interval-ms') {
      const value = argv[index + 1];
      if (!value) {
        console.error(`[kordi] Missing value for ${arg}`);
        process.exit(1);
      }

      if (arg === '--config') {
        options.configPath = resolve(process.cwd(), value);
      } else if (arg === '--users') {
        options.userIds = value
          .split(',')
          .map((item) => sanitizeSegment(item))
          .filter(Boolean);
      } else if (arg === '--timeout-ms') {
        options.timeoutMs = Number.parseInt(value, 10);
      } else if (arg === '--interval-ms') {
        options.intervalMs = Number.parseInt(value, 10);
      }

      index += 1;
      continue;
    }

    console.error(`[kordi] Unknown argument: ${arg}`);
    printHelp();
    process.exit(1);
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    console.error(`[kordi] Invalid --timeout-ms: ${options.timeoutMs}`);
    process.exit(1);
  }

  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    console.error(`[kordi] Invalid --interval-ms: ${options.intervalMs}`);
    process.exit(1);
  }

  return options;
}

function resolveConfig(options) {
  const fullConfig = loadMultiInstanceConfig(options.configPath, []);
  const selectedUserIds = options.userIds.length > 0
    ? options.userIds
    : fullConfig.users.slice(0, 2).map((user) => user.id);

  if (selectedUserIds.length !== 2) {
    throw new Error(`Smoke test requires exactly 2 users, received ${selectedUserIds.length}`);
  }

  return loadMultiInstanceConfig(options.configPath, selectedUserIds);
}

function isReadyState(state) {
  return Boolean(
    state.pidRunning
      && state.metaExists
      && state.metaMatches
      && state.authExists
      && state.authSummary?.providerIds?.length
      && state.logHasProfileStart
      && state.logHasGeneratedConfig,
  );
}

async function waitForInstanceReady(instance, options) {
  return waitFor(() => {
    const state = currentInstanceSmokeState(instance);
    return isReadyState(state) ? state : false;
  }, {
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
    description: `${instance.id} startup readiness`,
  });
}

const options = parseArgs(process.argv.slice(2));
const config = resolveConfig(options);

if (options.dryRun) {
  console.log(JSON.stringify({
    command: 'smoke',
    leaveRunning: options.leaveRunning,
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
    ...summarizeConfig(config),
  }, null, 2));
  process.exit(0);
}

ensureMultiInstanceDirs(config);

const startedInstances = [];
let failed = false;

try {
  console.log(`[kordi] Resetting ${config.users.length} smoke-test user(s)...`);
  for (const instance of config.users) {
    const result = await stopInstance(instance);
    removeInstanceArtifacts(instance);
    console.log(`[kordi] ${instance.id}: ${result.stopped ? `stopped pid ${result.pid}` : 'no running process found'}; data cleared`);
  }

  const bootstrapResults = [];
  for (const instance of config.users) {
    const bootstrap = prepareInstanceEnvironment(config, instance, { forceBootstrap: true });
    bootstrapResults.push(bootstrap);
    if (!instance.bootstrap?.authSource && !instance.bootstrap?.authFile) {
      throw new Error(`Smoke test requires bootstrap auth for ${instance.id}`);
    }
    console.log(`[kordi] ${instance.id}: auth bootstrap ${bootstrap.seeded ? 'ready' : bootstrap.reason}`);
  }

  await assertPortsAvailable(config.users);

  console.log(`[kordi] Launching ${config.users.length} smoke-test instance(s)...`);
  for (const instance of config.users) {
    const launched = launchDetachedInstance(instance, { inheritedEnv: process.env, clean: false });
    startedInstances.push(instance);
    console.log(`[kordi] ${instance.id}: launched pid ${launched.pid} on port ${instance.port}`);
  }

  const results = [];
  for (const instance of config.users) {
    const readyState = await waitForInstanceReady(instance, options);
    results.push(readyState);
    console.log(`[kordi] ${instance.id}: ready (providers=${readyState.authSummary.providerIds.join(',') || 'none'})`);
  }

  console.log(JSON.stringify({
    ok: true,
    leaveRunning: options.leaveRunning,
    users: results.map((result) => ({
      id: result.id,
      pid: result.pid,
      authPath: result.authPath,
      authProviders: result.authSummary?.providerIds ?? [],
      logFile: result.logFile,
      metaExists: result.metaExists,
      logHasProfileStart: result.logHasProfileStart,
      logHasGeneratedConfig: result.logHasGeneratedConfig,
    })),
  }, null, 2));
} catch (error) {
  failed = true;
  const states = config.users.map((instance) => currentInstanceSmokeState(instance));
  console.error(`[kordi] Smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    users: states,
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (!options.leaveRunning) {
    for (const instance of startedInstances) {
      const result = await stopInstance(instance);
      console.log(`[kordi] ${instance.id}: ${result.stopped ? `stopped pid ${result.pid}` : 'already stopped'} after smoke test`);
    }
  }

  if (!failed) {
    console.log(options.leaveRunning
      ? '[kordi] Smoke test passed. Instances are still running.'
      : '[kordi] Smoke test passed. Instances were stopped; logs and data were preserved.');
  }
}

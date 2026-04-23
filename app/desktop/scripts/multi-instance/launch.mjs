import { openSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';

import {
  appRoot,
  applyBootstrap,
  assertPortsAvailable,
  ensureMultiInstanceDirs,
  loadMultiInstanceConfig,
  parseCommonArgs,
  removeInstanceArtifacts,
  sleep,
  stopInstance,
  summarizeConfig,
  tauriDevInstanceScript,
  writeInstanceMetadata,
} from './shared.mjs';

const options = parseCommonArgs(process.argv.slice(2), {
  command: 'tauri:dev:multi',
});

const config = loadMultiInstanceConfig(options.configPath, options.userIds);

if (options.dryRun) {
  console.log(JSON.stringify({
    reset: options.reset,
    command: tauriDevInstanceScript,
    ...summarizeConfig(config),
  }, null, 2));
  process.exit(0);
}

ensureMultiInstanceDirs(config);

if (options.reset) {
  console.log('[kordi] Resetting selected multi-instance users before launch...');
  for (const instance of config.users) {
    const result = await stopInstance(instance);
    removeInstanceArtifacts(instance);
    console.log(`[kordi] ${instance.id}: ${result.stopped ? `stopped pid ${result.pid}` : 'no running process found'}; data cleared`);
  }
}

for (const instance of config.users) {
  ensureMultiInstanceDirs({
    ...config,
    dataRoot: instance.dataDir,
    logsRoot: instance.logDir,
    runtimeRoot: config.runtimeRoot,
  });
  const bootstrap = applyBootstrap(instance, { force: options.reset });
  if (bootstrap.seeded) {
    console.log(`[kordi] ${instance.id}: bootstrapped auth fixture -> ${bootstrap.authTargetPath}`);
  }
}

await assertPortsAvailable(config.users);

console.log(`[kordi] Launching ${config.users.length} isolated desktop instance(s)...`);
for (const instance of config.users) {
  const logFd = openSync(instance.logFile, 'a');
  writeSync(logFd, `\n=== ${new Date().toISOString()} launching ${instance.id} on port ${instance.port} ===\n`);

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

  if (!options.reset && instance.cleanOnLaunch) {
    args.push('--clean');
  }

  const child = spawn(process.execPath, args, {
    cwd: appRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });

  child.unref();

  writeInstanceMetadata(instance, {
    pid: child.pid,
    startedAt: new Date().toISOString(),
  });

  console.log(`[kordi] ${instance.id} -> port ${instance.port}`);
  console.log(`         title: ${instance.title}`);
  console.log(`         data:  ${instance.dataDir}`);
  console.log(`         log:   ${instance.logFile}`);
  if (instance.bootstrap?.authSummary) {
    console.log(`         auth:  source=${instance.bootstrap.authSource} providers=${instance.bootstrap.authSummary.providerIds.join(',') || 'none'} mode=${instance.bootstrap.authMode}`);
  }

  await sleep(750);
}

console.log('[kordi] Multi-instance launch requested. Use the per-instance logs above to monitor startup.');

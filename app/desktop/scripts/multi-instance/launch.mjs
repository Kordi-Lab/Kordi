import {
  assertPortsAvailable,
  ensureMultiInstanceDirs,
  launchDetachedInstance,
  loadMultiInstanceConfig,
  parseCommonArgs,
  prepareInstanceEnvironment,
  removeInstanceArtifacts,
  sleep,
  stopInstance,
  summarizeConfig,
  tauriDevInstanceScript,
} from './shared.mjs';

const options = parseCommonArgs(process.argv.slice(2), {
  command: 'tauri:dev:multi',
});

const config = loadMultiInstanceConfig(options.configPath, options.userIds);

if (options.dryRun) {
  console.log(JSON.stringify({
    reset: options.reset,
    sharedAuth: options.sharedAuth,
    command: tauriDevInstanceScript,
    ...summarizeConfig(config),
  }, null, 2));
  process.exit(0);
}

ensureMultiInstanceDirs(config);

if (options.sharedAuth) {
  const missingSharedAuth = config.users.filter((instance) => !instance.bootstrap?.authFile);
  if (missingSharedAuth.length > 0) {
    throw new Error(`--shared-auth requires a configured bootstrap auth file for: ${missingSharedAuth.map((instance) => instance.id).join(', ')}`);
  }
}

if (options.reset) {
  console.log('[kordi] Resetting selected multi-instance users before launch...');
  for (const instance of config.users) {
    const result = await stopInstance(instance);
    removeInstanceArtifacts(instance);
    console.log(`[kordi] ${instance.id}: ${result.stopped ? `stopped pid ${result.pid}` : 'no running process found'}; data cleared`);
  }
}

for (const instance of config.users) {
  const bootstrap = prepareInstanceEnvironment(config, instance, {
    forceBootstrap: options.reset,
    skipBootstrap: options.sharedAuth,
  });
  if (bootstrap.seeded) {
    console.log(`[kordi] ${instance.id}: bootstrapped auth fixture -> ${bootstrap.authTargetPath}`);
  }
}

await assertPortsAvailable(config.users);

console.log(`[kordi] Launching ${config.users.length} isolated desktop instance(s)...`);
for (const instance of config.users) {
  const authPath = options.sharedAuth ? instance.bootstrap?.authFile : null;
  launchDetachedInstance(instance, {
    inheritedEnv: authPath
      ? { ...process.env, KORDI_AUTH_PATH: authPath }
      : process.env,
    clean: !options.reset && instance.cleanOnLaunch,
  });

  console.log(`[kordi] ${instance.id} -> port ${instance.port}`);
  console.log(`         title: ${instance.title}`);
  console.log(`         data:  ${instance.dataDir}`);
  console.log(`         log:   ${instance.logFile}`);
  if (instance.bootstrap?.authSummary) {
    const authMode = options.sharedAuth ? `shared-path=${instance.bootstrap.authFile}` : `mode=${instance.bootstrap.authMode}`;
    console.log(`         auth:  source=${instance.bootstrap.authSource} providers=${instance.bootstrap.authSummary.providerIds.join(',') || 'none'} ${authMode}`);
  }

  await sleep(750);
}

console.log('[kordi] Multi-instance launch requested. Use the per-instance logs above to monitor startup.');

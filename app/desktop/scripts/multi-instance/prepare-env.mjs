import {
  applyBootstrap,
  ensureMultiInstanceDirs,
  loadMultiInstanceConfig,
  parseCommonArgs,
  removeInstanceArtifacts,
  summarizeConfig,
} from './shared.mjs';

const options = parseCommonArgs(process.argv.slice(2), {
  command: 'tauri:dev:multi:prepare',
});

const config = loadMultiInstanceConfig(options.configPath, options.userIds);

if (options.dryRun) {
  console.log(JSON.stringify({
    reset: options.reset,
    dryRun: true,
    ...summarizeConfig(config),
  }, null, 2));
  process.exit(0);
}

ensureMultiInstanceDirs(config);

if (options.reset) {
  for (const instance of config.users) {
    removeInstanceArtifacts(instance);
  }
}

const bootstrapResults = [];
for (const instance of config.users) {
  ensureMultiInstanceDirs({
    ...config,
    dataRoot: instance.dataDir,
    logsRoot: instance.logDir,
    runtimeRoot: config.runtimeRoot,
  });
  bootstrapResults.push(applyBootstrap(instance, { force: options.reset }));
}

console.log(JSON.stringify({
  reset: options.reset,
  dryRun: false,
  bootstrapResults,
  ...summarizeConfig(config),
}, null, 2));

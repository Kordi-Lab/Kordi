import {
  ensureMultiInstanceDirs,
  loadMultiInstanceConfig,
  parseCommonArgs,
  prepareInstanceEnvironment,
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
  bootstrapResults.push(prepareInstanceEnvironment(config, instance, { forceBootstrap: options.reset }));
}

console.log(JSON.stringify({
  reset: options.reset,
  dryRun: false,
  bootstrapResults,
  ...summarizeConfig(config),
}, null, 2));

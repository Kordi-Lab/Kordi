import {
  ensureMultiInstanceDirs,
  loadMultiInstanceConfig,
  parseCommonArgs,
  removeInstanceArtifacts,
  stopInstance,
  summarizeConfig,
} from './shared.mjs';

const options = parseCommonArgs(process.argv.slice(2), {
  command: 'tauri:dev:multi:reset',
});

const config = loadMultiInstanceConfig(options.configPath, options.userIds);
ensureMultiInstanceDirs(config);

if (options.dryRun) {
  console.log(JSON.stringify({
    command: 'reset',
    ...summarizeConfig(config),
  }, null, 2));
  process.exit(0);
}

console.log(`[kordi] Resetting ${config.users.length} configured instance(s)...`);
for (const instance of config.users) {
  const result = await stopInstance(instance);
  removeInstanceArtifacts(instance);
  console.log(`[kordi] ${instance.id}: ${result.stopped ? `stopped pid ${result.pid}` : 'no running process found'}; cleared data/logs/runtime files`);
}

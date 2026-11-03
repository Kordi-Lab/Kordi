import { authenticationBindings } from '../shared/configuration/authentication.mjs';
import { spawn } from 'node:child_process';
import { distributionFromEnvironment, serviceEnvironment } from '../shared/configuration/distribution-files.mjs';
// This is a process adapter for an already authorized environment, not a deploy command.
try {
  const [service, binary, ...args] = process.argv.slice(2);
  if (!binary || !['server', 'runner'].includes(service)) throw new Error();
  const { profile } = distributionFromEnvironment();
  if (service === 'runner') {
    const required = profile.services.runner.sandboxBackend === 'k8s'
      ? ['KORDI_CLOUD_SANDBOX_NAMESPACE', 'KORDI_CLOUD_SANDBOX_IMAGE']
      : ['KORDI_FLY_SANDBOX_APP', 'KORDI_FLY_SANDBOX_REGION', 'KORDI_FLY_SANDBOX_IMAGE', 'KORDI_FLY_SANDBOX_TOKEN'];
    if (required.some((key) => !process.env[key]?.trim())) throw new Error();
  }
  const child = spawn(binary, args, { stdio: 'inherit', shell: false,
    env: { ...process.env, ...serviceEnvironment(profile, service), ...(service === 'server' ? authenticationBindings(profile, process.env) : {}) } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Configured service could not start.'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} catch {
  console.error('Supply server or runner, an executable, and a valid independently selected ops profile.');
  process.exitCode = 1;
}

import { createHash } from 'node:crypto';
import { legacyBackendEnvironment, validateBackendConfiguration } from './backend.mjs';

/** Produce backend-only inputs. This function never writes files or starts a process. */
export function backendConfigurationArtifacts(value, expected) {
  const config = validateBackendConfiguration(value, expected);
  const env = legacyBackendEnvironment(config, expected);
  const configuration = `${JSON.stringify(config, null, 2)}\n`;
  const digest = createHash('sha256').update(configuration).digest('hex');
  return Object.freeze({
    'backend.json': configuration,
    'desktop.env': `VITE_KORDI_CLOUD_API_BASE=${env.VITE_KORDI_CLOUD_API_BASE}\n`,
    'runner.env': `KORDI_CLOUD_API_BASE=${env.KORDI_CLOUD_API_BASE}\n`,
    'manifest.json': `${JSON.stringify({
      schemaVersion: config.schemaVersion,
      edition: config.edition,
      environment: config.environment,
      configurationSha256: digest,
      scope: 'backend-routing-only',
    }, null, 2)}\n`,
  });
}

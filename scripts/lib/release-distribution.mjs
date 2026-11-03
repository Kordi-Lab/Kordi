import { distributionFromEnvironment } from '../../shared/configuration/distribution-files.mjs';

const selection = distributionFromEnvironment(process.env, { required: false });
export function releaseDistribution() {
  if (!selection) throw new Error('Release tools require a validated ops distribution profile.');
  return selection.profile;
}
// Missing configuration is never replaced with another edition's origin or signing key.
export const releaseOrigin = selection?.profile.routing.backend.origin ?? '';
export const updaterPublicKey = selection?.profile.clients.updates.publicKey ?? '';

export function releaseArtifactNames(version) {
  const { updates } = releaseDistribution().clients;
  if (!updates.enabled) throw new Error('Updates are disabled for this distribution.');
  return {
    manualName: `${updates.artifactName}_${version}_aarch64.dmg`,
    updaterName: `${updates.artifactName}.app.tar.gz`,
  };
}

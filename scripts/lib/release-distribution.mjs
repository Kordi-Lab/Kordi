import { distributionFromEnvironment } from '../../shared/configuration/distribution-files.mjs';

const selection = distributionFromEnvironment(process.env, { required: false });
export function releaseDistribution() {
  if (!selection) throw new Error('Release tools require a validated ops distribution profile.');
  return selection.profile;
}
// Missing configuration is never replaced with another edition's origin or signing key.
export const releaseOrigin = selection?.profile.routing.backend.origin ?? '';
export const updaterPublicKey = selection?.profile.clients.updates.publicKey ?? '';

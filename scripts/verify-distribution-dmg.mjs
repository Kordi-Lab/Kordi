import { distributionFromEnvironment } from '../shared/configuration/distribution-files.mjs';
import { verifyDmgArtifact } from '../app/desktop/scripts/assert-macos-dmg-release.mjs';
try {
  const { profile } = distributionFromEnvironment();
  verifyDmgArtifact({ appName: profile.clients.updates.artifactName });
  console.log('Selected distribution DMG layout and sidecar checks passed.');
} catch {
  console.error('Distribution DMG verification failed. Check the selected profile and built artifact.');
  process.exitCode = 1;
}

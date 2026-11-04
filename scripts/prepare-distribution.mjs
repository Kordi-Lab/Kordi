import { distributionFromEnvironment, writeDistributionArtifacts } from '../shared/configuration/distribution-files.mjs';
try {
  const selection = distributionFromEnvironment();
  const args = process.argv.slice(2);
  if (args.length === 0) console.log('Distribution profile and icon assets are valid. No artifacts written.');
  else if (args.length === 2 && args[0] === '--output-dir') {
    writeDistributionArtifacts(selection, args[1]);
    console.log('Prepared local distribution artifacts. Nothing was built, signed or deployed.');
  } else throw new Error();
} catch {
  console.error('Distribution preparation failed. Check the profile, independent target selection, contained assets and new output directory.');
  process.exitCode = 1;
}

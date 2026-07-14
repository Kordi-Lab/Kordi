export const RELEASE_PROFILES = Object.freeze({
  PRODUCTION: 'production',
  ADHOC_PREVIEW: 'adhoc-preview',
});

const RELEASE_PROFILE_VALUES = Object.values(RELEASE_PROFILES);

function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function requireSuccessful(result, message) {
  if (result.status !== 0) {
    throw new Error(message);
  }
  return result;
}

function requireKnownProfile(profile) {
  if (!RELEASE_PROFILE_VALUES.includes(profile)) {
    throw new Error('Release profile must be production or adhoc-preview');
  }
}

export function assertProductionSigningIdentity(run) {
  const identities = requireSuccessful(
    run('security', ['find-identity', '-v', '-p', 'codesigning']),
    'Unable to inspect macOS signing identities',
  );
  const identityOutput = combinedOutput(identities);
  const validIdentityCount = identityOutput.match(/(\d+)\s+valid identities found/i);

  if (!/Developer ID Application:/i.test(identityOutput)
      || !validIdentityCount
      || Number(validIdentityCount[1]) < 1) {
    throw new Error('A valid Developer ID Application signing identity is required');
  }

  return { signingIdentityAvailable: true };
}

export function verifyMacAppSignature({ run, appBundle, profile }) {
  requireKnownProfile(profile);

  requireSuccessful(
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]),
    'codesign verification failed for the application bundle',
  );

  if (profile === RELEASE_PROFILES.PRODUCTION) {
    requireSuccessful(
      run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appBundle]),
      'Gatekeeper assessment failed for the application bundle',
    );

    return {
      codesignVerified: true,
      gatekeeperVerified: true,
      signingKind: 'developer-id',
    };
  }

  const displayedSignature = requireSuccessful(
    run('codesign', ['--display', '--verbose=4', appBundle]),
    'Unable to inspect the application bundle signature',
  );
  const signatureOutput = combinedOutput(displayedSignature);
  const teamIdentifiers = [...signatureOutput.matchAll(/^TeamIdentifier=(.*)$/gm)];
  const isIdentityFreeAdhoc = /^Signature=adhoc$/m.test(signatureOutput)
    && !/^Authority=/m.test(signatureOutput)
    && teamIdentifiers.every((match) => match[1] === 'not set');

  if (!isIdentityFreeAdhoc) {
    throw new Error('A valid identity-free ad-hoc code signature is required');
  }

  const gatekeeper = run(
    'spctl',
    ['--assess', '--type', 'execute', '--verbose=2', appBundle],
  );

  return {
    codesignVerified: true,
    gatekeeperVerified: gatekeeper.status === 0,
    signingKind: 'adhoc',
  };
}

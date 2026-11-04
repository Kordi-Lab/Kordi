// Synthetic test process only. Production builds receive the validated ops allowlist from Vite.
globalThis.__KORDI_DISTRIBUTION__ = {
  edition: 'app', environment: 'production', backendOrigin: 'https://kordi.ai',
  displayName: 'Kordi', callbackScheme: 'kordi', desktopIdentifier: 'io.kordi.cloud',
  updates: { enabled: true, publicKey: '', artifactName: 'Kordi' },
};

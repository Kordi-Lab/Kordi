import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudApiBaseUrl } from '../src/features/cloud/cloudApiEnvironment';
import { documentShareTokenFromUrl } from '../src/features/documents/documentShareToken';
import { manualUpdateUrlForVersion } from '../src/features/updates/desktopUpdater';
import type { ClientDistribution } from '../src/features/cloud/distribution';

test('Research uses its own backend and rejects App updates and links', () => {
  const scope = globalThis as typeof globalThis & { __KORDI_DISTRIBUTION__?: ClientDistribution };
  const previous = scope.__KORDI_DISTRIBUTION__;
  try {
    scope.__KORDI_DISTRIBUTION__ = {
      edition: 'research', environment: 'production', backendOrigin: 'https://research.example.test',
      displayName: 'Research', desktopIdentifier: 'test.research.desktop', callbackScheme: 'sample-research',
      updates: { enabled: false, publicKey: '', artifactName: 'Research' },
    };
    assert.equal(cloudApiBaseUrl({}), 'https://research.example.test');
    assert.throws(() => cloudApiBaseUrl({ VITE_KORDI_CLOUD_API_BASE: 'https://kordi.ai' }), /does not match/);
    assert.equal(manualUpdateUrlForVersion('0.0.2-beta.6'), undefined);
    const token = `kordi_ds_${'a'.repeat(43)}`;
    assert.equal(documentShareTokenFromUrl(`https://research.example.test/d/${token}`), token);
    assert.equal(documentShareTokenFromUrl(`sample-research://document/${token}`), token);
    assert.equal(documentShareTokenFromUrl(`https://kordi.ai/d/${token}`), null);
    assert.equal(documentShareTokenFromUrl(`kordi://document/${token}`), null);
    delete scope.__KORDI_DISTRIBUTION__;
    assert.throws(() => cloudApiBaseUrl({}), /distribution profile is required/);
    assert.throws(() => cloudApiBaseUrl({ VITE_KORDI_CLOUD_API_BASE: 'https://kordi.ai' }), /distribution profile is required/);
  } finally {
    scope.__KORDI_DISTRIBUTION__ = previous;
  }
});

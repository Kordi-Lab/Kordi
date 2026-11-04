import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../app/desktop/package.json', import.meta.url));
const { parse } = require('yaml');

test('Beta retains its existing identities, callback, loopback origin and gray icon', () => {
  const spec = parse(readFileSync(new URL('../app/ios/project.yml', import.meta.url), 'utf8'));
  for (const name of ['Kordi', 'KordiShareExtension']) {
    const beta = spec.targets[name].settings.configs.Beta;
    assert.equal(beta.KORDI_CLOUD_BASE_URL, 'http://127.0.0.1:17081');
    assert.equal(beta.KORDI_DISTRIBUTION_CHANNEL, 'beta');
    assert.equal(beta.KORDI_OAUTH_CALLBACK_SCHEME, 'kordi-beta');
    assert.equal(beta.KORDI_SHARE_APP_GROUP, 'group.ai.kordi.beta.share');
    assert.equal(beta.KORDI_SHARE_CREDENTIAL_SERVICE, 'ai.kordi.beta.share-session');
    assert.equal(beta.PRODUCT_BUNDLE_IDENTIFIER, name === 'Kordi' ? 'ai.kordi.ios.beta' : 'ai.kordi.ios.beta.share');
    assert.match(beta.SWIFT_ACTIVE_COMPILATION_CONDITIONS, /\bBETA\b/);
  }
  assert.equal(spec.targets.Kordi.settings.configs.Beta.ASSETCATALOG_COMPILER_APPICON_NAME, 'AppIconBeta');
  assert.equal(spec.schemes['Kordi Beta'].run.config, 'Beta');
  assert.equal(spec.schemes['Kordi Research'].run.config, 'Research');
});

const swift = spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).status === 0;
test('native validator accepts App and Research and rejects cross-edition routing without changing Beta', { skip: !swift }, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'distribution-swift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main.swift');
  writeFileSync(main, `import Foundation
func info(_ channel: String, _ origin: String, _ scheme: String) -> [String: Any] {
    ["KordiDistributionChannel": channel, "KordiCloudBaseURL": origin,
     "KordiOAuthCallbackScheme": scheme,
     "KordiExpectedDistribution": DistributionTestFixture.encoded(research: channel == "research")]
}
let app = try KordiAppEnvironment.configured(infoDictionary: info("production", "https://kordi.ai", "kordi"), bundleIdentifier: "ai.kordi.ios")
precondition(app.keychainService == "ai.kordi.ios")
let research = try KordiAppEnvironment.configured(infoDictionary: info("research", "https://research.example.test", "kordi-research"), bundleIdentifier: "ai.kordi.ios.research")
precondition(research.keychainService != app.keychainService)
let beta = try KordiAppEnvironment.configured(infoDictionary: info("beta", "http://127.0.0.1:17081", "kordi-beta"), bundleIdentifier: "ai.kordi.ios.beta")
precondition(beta.channel == .beta)
precondition((try? KordiAppEnvironment.configured(infoDictionary: info("research", "https://kordi.ai", "kordi-research"), bundleIdentifier: "ai.kordi.ios.research")) == nil)
precondition((try? KordiAppEnvironment.configured(infoDictionary: info("beta", "https://research.example.test", "kordi-beta"), bundleIdentifier: "ai.kordi.ios.beta")) == nil)
precondition((try? KordiAppEnvironment.configured(infoDictionary: info("production", "https://kordi.ai", "kordi"), bundleIdentifier: "ai.kordi.ios.research")) == nil)
`);
  const result = spawnSync('swiftc', ['-D', 'BETA', '-module-cache-path', path.join(root, 'cache'),
    'app/ios/Kordi/Core/Environment/KordiReleaseConfiguration.swift',
    'app/ios/Kordi/Core/Environment/KordiAppEnvironment.swift',
    'app/ios/KordiTests/DistributionTestFixture.swift', main, '-o', path.join(root, 'verify')], { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(spawnSync(path.join(root, 'verify'), [], { encoding: 'utf8' }).status, 0);
});

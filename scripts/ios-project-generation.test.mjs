import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../app/desktop/package.json', import.meta.url));
const { parse } = require('yaml');
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const accessGroup = '$(AppIdentifierPrefix)$(KORDI_SHARE_CREDENTIAL_SERVICE)';

test('both iOS targets generate the shared Keychain entitlement and lookup group', async () => {
  const spec = parse(await readFile(join(repoRoot, 'app/ios/project.yml'), 'utf8'));
  assert.deepEqual(
    spec.targets.KordiShareExtension.entitlements.properties['keychain-access-groups'], [accessGroup],
  );
  for (const file of ['Kordi.entitlements', 'KordiProduction.entitlements']) {
    const entitlements = await readFile(join(repoRoot, 'app/ios/Kordi/Supporting', file), 'utf8');
    assert.match(entitlements, /<key>keychain-access-groups<\/key>\s*<array>\s*<string>([^<]+)<\/string>\s*<\/array>/, file);
    assert.ok(entitlements.includes(`<string>${accessGroup}</string>`), file);
  }
  for (const name of ['Kordi', 'KordiShareExtension']) {
    const target = spec.targets[name];
    assert.equal(target.info.properties.KordiShareKeychainAccessGroup, accessGroup, name);
    assert.equal(
      target.info.properties.KordiShareCredentialService,
      '$(KORDI_SHARE_CREDENTIAL_SERVICE)', name,
    );
  }
  for (const config of ['Beta', 'Debug', 'Release']) {
    const app = spec.targets.Kordi.settings.configs[config];
    const extension = spec.targets.KordiShareExtension.settings.configs[config];
    assert.equal(app.KORDI_SHARE_CREDENTIAL_SERVICE, extension.KORDI_SHARE_CREDENTIAL_SERVICE);
    assert.equal(app.KORDI_SHARE_APP_GROUP, extension.KORDI_SHARE_APP_GROUP);
  }
  assert.notEqual(
    spec.targets.Kordi.settings.configs.Beta.KORDI_SHARE_CREDENTIAL_SERVICE,
    spec.targets.Kordi.settings.configs.Release.KORDI_SHARE_CREDENTIAL_SERVICE,
  );
});

test('only the production app signs with the kordi.ai universal link domains', async () => {
  const spec = parse(await readFile(join(repoRoot, 'app/ios/project.yml'), 'utf8'));
  const app = spec.targets.Kordi;
  const base = 'Kordi/Supporting/Kordi.entitlements';
  const production = 'Kordi/Supporting/KordiProduction.entitlements';
  assert.equal(app.entitlements, undefined, 'generated entitlements would override every configuration');
  assert.equal(app.settings.base.CODE_SIGN_ENTITLEMENTS, base);
  for (const [config, settings] of Object.entries(app.settings.configs)) {
    const expected = ['Debug', 'Release'].includes(config) ? production : undefined;
    assert.equal(settings.CODE_SIGN_ENTITLEMENTS, expected, config);
  }
  const domainsKey = 'com.apple.developer.associated-domains';
  const read = (file) => readFile(join(repoRoot, 'app/ios', file), 'utf8');
  const withoutDomains = (xml) => xml.replace(
    new RegExp(`\\s*<key>${domainsKey.replaceAll('.', '\\.')}</key>\\s*<array>[\\s\\S]*?</array>`), '',
  );
  const baseXml = await read(base);
  const productionXml = await read(production);
  assert.ok(!baseXml.includes(domainsKey));
  assert.equal(withoutDomains(productionXml), baseXml, 'production must add only Associated Domains');
  assert.match(
    productionXml,
    /<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>\s*<string>applinks:kordi\.ai<\/string>\s*<string>applinks:www\.kordi\.ai<\/string>\s*<\/array>/,
  );
});

const hasXcodeGen = spawnSync('xcodegen', ['--version'], { stdio: 'ignore' }).status === 0;
test('XcodeGen preserves committed iOS project and sharing configuration on repeated generation', {
  skip: hasXcodeGen ? false : 'XcodeGen is required for generation integration coverage',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kordi-project-generation-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repoRoot, 'app/ios'), join(root, 'app/ios'), { recursive: true });
  await cp(join(repoRoot, 'shared/digest'), join(root, 'shared/digest'), { recursive: true });
  await cp(join(repoRoot, 'shared/agent-targeting'), join(root, 'shared/agent-targeting'), { recursive: true });
  await cp(join(repoRoot, 'shared/omp-catalog'), join(root, 'shared/omp-catalog'), { recursive: true });
  const generatedFiles = [
    'Kordi.xcodeproj/project.pbxproj',
    'Kordi/Supporting/Info.plist',
    'Kordi/Supporting/Kordi.entitlements',
    'KordiShareExtension/Supporting/Info.plist',
    'KordiShareExtension/Supporting/KordiShareExtension.entitlements',
  ];
  for (let run = 0; run < 2; run += 1) {
    const result = spawnSync('xcodegen', ['generate'], {
      cwd: join(root, 'app/ios'), encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, 'XcodeGen must succeed without building or signing');
    for (const file of generatedFiles) {
      const generated = await readFile(join(root, 'app/ios', file));
      const committed = await readFile(join(repoRoot, 'app/ios', file));
      assert.ok(generated.equals(committed), `${file} must reproduce the committed configuration`);
    }
  }
});

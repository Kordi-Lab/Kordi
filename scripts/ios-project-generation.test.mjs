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
  for (const name of ['Kordi', 'KordiShareExtension']) {
    const target = spec.targets[name];
    assert.deepEqual(target.entitlements.properties['keychain-access-groups'], [accessGroup], name);
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

const hasXcodeGen = spawnSync('xcodegen', ['--version'], { stdio: 'ignore' }).status === 0;
test('XcodeGen preserves committed iOS project and sharing configuration on repeated generation', {
  skip: hasXcodeGen ? false : 'XcodeGen is required for generation integration coverage',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kordi-project-generation-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repoRoot, 'app/ios'), join(root, 'app/ios'), { recursive: true });
  await cp(join(repoRoot, 'shared/digest'), join(root, 'shared/digest'), { recursive: true });
  await cp(join(repoRoot, 'shared/agent-targeting'), join(root, 'shared/agent-targeting'), { recursive: true });
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

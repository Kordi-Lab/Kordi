import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

function python(code) {
  const result = spawnSync('python3', ['-B', '-c', `
import importlib.util
spec = importlib.util.spec_from_file_location('preparation', 'scripts/prepare-ios-uniffi.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${code}
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('privacy gate rejects all forbidden path classes without exposing bytes', () => {
  python(`
for prefix in m.FORBIDDEN:
    try:
        m.check_privacy(b'header' + prefix + b'private-account/source')
    except RuntimeError as error:
        assert 'private-account' not in str(error)
    else:
        raise AssertionError('private path accepted')
m.check_privacy(b'/build/source/main.rs')
`);
});

test('binding qualification ignores only blank lines and rejects interface changes', () => {
  python(`
m.compare_bindings('struct Claims {\\n\\n}\\n', 'struct Claims {\\n \\n\\n}\\n')
for changed in ['struct Other {\\n}', 'struct Claims { let field: Int\\n}']:
    try:
        m.compare_bindings('struct Claims {\\n}', changed)
    except RuntimeError:
        pass
    else:
        raise AssertionError('changed interface accepted')
`);
});

test('manifest override pins checksum and affects only the intended binary source', () => {
  python(`
original = 'prefix\\n' + f'url: "{m.URL}",\\n            checksum: "{m.BINARY_CHECKSUM}"' + '\\nsuffix'
assert m.manifest_override(original) == f'prefix\\npath: "{m.LOCAL_TARGET}"\\nsuffix'
for bad in [original.replace(m.BINARY_CHECKSUM, 'wrong'), original + original]:
    try:
        m.manifest_override(bad)
    except RuntimeError:
        pass
    else:
        raise AssertionError('unexpected input accepted')
`);
});

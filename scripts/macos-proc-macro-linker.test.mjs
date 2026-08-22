import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const linker = path.join(scriptsDirectory, 'macos-proc-macro-linker.sh');

test('macOS release linker lowers only build-time proc-macro dylibs', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kordi-linker-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const capturedArguments = path.join(directory, 'arguments.txt');
  const fakeLinker = path.join(directory, 'linker.sh');
  await writeFile(fakeLinker, '#!/bin/bash\nprintf "%s\\n" "$@" > "$KORDI_CAPTURED_LINKER_ARGUMENTS"\n');
  await chmod(fakeLinker, 0o700);

  const run = (output, ...extraArguments) => spawnSync(linker, [
    '-Wl,-exported_symbols_list',
    '-mmacosx-version-min=12.0',
    '-o',
    output,
    ...extraArguments,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KORDI_CAPTURED_LINKER_ARGUMENTS: capturedArguments,
      KORDI_REAL_LINKER: fakeLinker,
    },
  });

  assert.equal(run(path.join(directory, 'release/deps/libderive.dylib')).status, 0);
  assert.match(await readFile(capturedArguments, 'utf8'), /-mmacosx-version-min=11\.0/);

  assert.equal(run(path.join(directory, 'release/libkordi_desktop_lib.dylib')).status, 0);
  assert.match(await readFile(capturedArguments, 'utf8'), /-mmacosx-version-min=12\.0/);
});

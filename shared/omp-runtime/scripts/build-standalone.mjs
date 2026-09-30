import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const runtimeDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDir = resolve(process.argv[2] ?? join(runtimeDir, 'dist'));
const targetTriple = process.argv[3] ?? process.env.TAURI_ENV_TARGET_TRIPLE;
if (!targetTriple) throw new Error('An explicit target triple is required.');

const platform = process.platform;
const arch = process.arch;
const expectedPrefix = `${arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch}-`;
const targetOs = platform === 'darwin' ? 'apple-darwin' : platform === 'win32' ? 'pc-windows' : 'unknown-linux';
if (!targetTriple.startsWith(expectedPrefix) || !targetTriple.includes(targetOs)) {
  throw new Error('OMP standalone compilation must run on its target platform and architecture.');
}

const nativePackage = `@oh-my-pi/pi-natives-${platform}-${arch}`;
const nativeName = `pi_natives.${platform}-${arch}.node`;
const nativePath = join(runtimeDir, 'node_modules', nativePackage, nativeName);
const nativeManifest = join(runtimeDir, 'node_modules', nativePackage, 'package.json');
const codingAgentManifest = join(runtimeDir, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json');
const pinnedVersion = readFileSync(join(runtimeDir, 'package.json'), 'utf8');
const expectedVersion = JSON.parse(pinnedVersion).dependencies['@oh-my-pi/pi-coding-agent'];
if (!existsSync(nativePath)
    || JSON.parse(readFileSync(nativeManifest, 'utf8')).version !== expectedVersion
    || JSON.parse(readFileSync(codingAgentManifest, 'utf8')).version !== expectedVersion) {
  throw new Error('Version-matched OMP coding agent and native addon must be installed for this target.');
}

mkdirSync(outputDir, { recursive: true });
const executable = join(outputDir, `kordi-omp-${targetTriple}${platform === 'win32' ? '.exe' : ''}`);
// OMP's optional legacy plugin bridge is unreachable: Kordi disables ambient
// extension discovery and supplies only explicit host tools. Keeping it external
// avoids bundling an undeclared optional package.
const build = spawnSync('bun', [
  'build', '--compile', 'src/worker.ts', '--external', 'omp-legacy-pi-modules',
  '--outfile', executable,
], { cwd: runtimeDir, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

// The pinned pi-natives loader resolves a compiled Bun process's addon from
// process.execPath's directory. Tauri externalBin strips the target suffix and
// places both files together in Contents/MacOS. The unsuffixed copy supports
// direct local smoke tests of the staging output.
copyFileSync(nativePath, join(outputDir, nativeName));
copyFileSync(nativePath, join(outputDir, `${nativeName}-${targetTriple}`));
console.log(`Built OMP standalone runtime and native addon for ${targetTriple}.`);

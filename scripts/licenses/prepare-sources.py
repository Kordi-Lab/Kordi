#!/usr/bin/env python3
"""Prepare version-pinned source/relink material without building or publishing it.

Run before signing. A reviewed release still requires a successful rebuild and
artifact-bound native evidence; this command never marks that review complete.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT).strip():
        raise RuntimeError('Prepare release sources from a clean committed checkout')
    release_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    pins = json.loads((ROOT / 'legal/runtime-sources.json').read_text())
    runtime = json.loads((ROOT / 'shared/omp-runtime/package.json').read_text())
    if runtime['packageManager'] != 'bun@' + pins['bunVersion']:
        raise RuntimeError('Review source pins after upgrading Bun')
    records = {}
    for name, pin in pins['sources'].items():
        path = output / (name + '.tar.gz')
        if not path.exists():
            temporary = path.with_suffix('.download')
            if 'git' in pin:
                with tempfile.TemporaryDirectory(prefix='kordi-license-source-') as checkout:
                    subprocess.run(['git', 'init', '-q', checkout], check=True)
                    subprocess.run(['git', '-C', checkout, 'fetch', '--depth=1', pin['git'], pin['revision']], check=True)
                    with temporary.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0, compresslevel=6) as stream:
                        process = subprocess.Popen(['git', '-C', checkout, 'archive', '--format=tar', pin['revision']], stdout=subprocess.PIPE)
                        shutil.copyfileobj(process.stdout, stream)
                        if process.wait():
                            raise RuntimeError('Source archive generation failed')
            else:
                with urllib.request.urlopen(pin['url'], timeout=180) as response, temporary.open('wb') as stream:
                    shutil.copyfileobj(response, stream)
            temporary.replace(path)
        actual = digest(path)
        if actual != pin['sha256']:
            raise RuntimeError('Source archive checksum mismatch: ' + name)
        records[name] = {'path': path.name, 'sha256': actual, 'upstream': pin.get('url', pin.get('git')), 'revision': pin.get('revision')}
    # Only tracked runtime/notice inputs, never local secrets, caches or sessions.
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--', 'shared/omp-runtime', 'legal/distribution', 'legal/runtime-sources.json', 'legal/runtime-relink-verification.json', 'scripts/licenses', 'scripts/licenses.mjs', 'docs/runtime-relinking.md'], cwd=ROOT).decode().split('\0')
    if 'shared/omp-runtime/scripts/runtime-licenses.mjs' not in paths or 'legal/distribution/manifest.json' not in paths:
        raise RuntimeError('Prepare the source kit from a release checkout containing the reviewed license changes')
    sources = output / 'application.tar.gz'
    def public_metadata(info):
        info.uid = info.gid = info.mtime = 0
        info.uname = info.gname = ''
        info.pax_headers = {}
        return info

    with sources.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as archive:
        for name in sorted(filter(None, paths)):
            path = ROOT / name
            if path.is_symlink() or not path.is_file():
                raise RuntimeError('Unexpected runtime source input')
            archive.add(path, arcname=name, recursive=False, filter=public_metadata)
    records['application'] = {'path': sources.name, 'sha256': digest(sources)}
    instructions = output / 'relink-instructions.md'
    instructions.write_text((ROOT / 'legal/SOURCES.md').read_text())
    records['relink-instructions'] = {'path': instructions.name, 'sha256': digest(instructions)}
    (output / 'source-manifest.json').write_text(json.dumps({'schemaVersion': 1, 'releaseCommit': release_commit, 'catalogSha256': digest(ROOT / 'legal/catalog.json'), 'bunVersion': pins['bunVersion'], 'sources': records, 'reviewStatus': 'pending'}, indent=2) + '\n')
    print('Prepared source material. Rebuild/relink and native-dependency review remain required before publication.')


if __name__ == '__main__':
    main()

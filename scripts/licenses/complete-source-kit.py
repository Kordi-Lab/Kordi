#!/usr/bin/env python3
"""Add the exact dependency sources and rebuild patches used by a verified build."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[2]

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def archive_sources(output, inputs):
    def public_metadata(info):
        info.uid = info.gid = info.mtime = 0
        info.uname = info.gname = ''
        info.pax_headers = {}
        if info.issym() and Path(info.linkname).is_absolute():
            raise RuntimeError('Absolute source symlink is not distributable')
        return info
    with output.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as archive:
        for source, name in inputs:
            source = source.resolve()
            if not source.exists():
                raise RuntimeError('A required verified build input is missing')
            paths = [source] + sorted(source.rglob('*')) if source.is_dir() else [source]
            for path in paths:
                relative = Path(name) / path.relative_to(source) if source.is_dir() else Path(name)
                if '.git' in relative.parts or path.name.endswith('.log'):
                    continue
                if path.is_file() and not path.is_symlink():
                    # Exact local-account path detection; no private bytes are logged.
                    with path.open('rb') as stream:
                        previous = b''
                        while block := stream.read(1024 * 1024):
                            if str(Path.home()).encode() in previous + block:
                                raise RuntimeError('A build input contains a local account path; do not distribute it')
                            previous = block[-1024:]
                archive.add(path, arcname=str(relative), recursive=False, filter=public_metadata)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--bun-source', required=True)
    parser.add_argument('--rust-vendor', required=True)
    args = parser.parse_args()
    output, bun, rust = Path(args.output), Path(args.bun_source), Path(args.rust_vendor)
    manifest = json.loads((output / 'source-manifest.json').read_text())
    groups = {
        'bun-build-inputs': [(bun / name, name) for name in ['vendor', 'node_modules', 'src/node-fallbacks/node_modules', 'packages/bun-error/node_modules']],
        'bun-rust-dependencies': [(rust, 'vendor-crates')],
        'application-dependencies': [(ROOT / 'shared/omp-runtime/node_modules', 'shared/omp-runtime/node_modules')],
        'build-patches': [(ROOT / 'legal/runtime-patches', 'patches'), (ROOT / 'docs/runtime-relinking.md', 'runtime-relinking.md')],
    }
    for name in ['src/node-fallbacks/bun.lock', 'packages/bun-error/bun.lock', 'bun.lock']:
        if (bun / name).is_file():groups['bun-build-inputs'].append((bun / name, name))
    for name, inputs in groups.items():
        path = output / (name + '.tar.gz')
        archive_sources(path, inputs)
        manifest['sources'][name] = {'path': path.name, 'sha256': digest(path)}
        print('Prepared ' + name, flush=True)
    (output / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

if __name__ == '__main__':
    main()

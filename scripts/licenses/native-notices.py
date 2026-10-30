#!/usr/bin/env python3
"""Retain notices from the exact Rust dependency graph of a native framework."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import re
import sys

# Reuse the reviewed license parser and text collector without executing main().
sys.path.insert(0, str(Path(__file__).parent))
from refresh import local_notices, spdx_ids


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--inventory')
    parser.add_argument('--target', default='aarch64-apple-ios')
    args = parser.parse_args()
    metadata = json.loads(subprocess.check_output([
        'cargo', 'metadata', '--locked', '--offline', '--format-version', '1',
        '--manifest-path', args.manifest,
    ]))
    catalog = json.loads((Path(__file__).resolve().parents[2] / 'legal/catalog.json').read_text())
    package = next(p for p in metadata['packages'] if Path(p['manifest_path']).resolve() == Path(args.manifest).resolve())
    tree = subprocess.check_output(['cargo', 'tree', '--locked', '--offline', '--manifest-path', args.manifest, '-p', package['name'], '--target', args.target, '-e', 'normal,build', '--prefix', 'none', '--format', '{p}'], text=True)
    selected = set(re.findall(r'^(\S+) v(\S+)', tree, re.M))
    records = []
    texts = {}
    entries = []
    for package in metadata['packages']:
        if (package['name'], package['version']) not in selected:
            continue
        license_id = package.get('license')
        if not license_id:
            raise RuntimeError('Native dependency needs license review: ' + package['name'])
        ids = spdx_ids(license_id)
        for identifier in ids:
            if identifier not in catalog['standardLicenses']:
                raise RuntimeError('Native license text needs review: ' + identifier)
            text = catalog['standardLicenses'][identifier]
            texts[hashlib.sha256(text.encode()).hexdigest()] = text
        directory = Path(package['manifest_path']).parent
        notices = local_notices(directory)
        if not package['source']:
            notices += [(p.name, p.read_text()) for p in Path(metadata['workspace_root']).iterdir() if p.name in {'LICENSE', 'NOTICE'}]
        for _, text in notices:
            texts[hashlib.sha256(text.encode()).hexdigest()] = text
        source_url = f"https://static.crates.io/crates/{package['name']}/{package['name']}-{package['version']}.crate" if package['source'] and package['source'].startswith('registry+') else 'https://github.com/livekit/rust-sdks/tree/598d0e3bd09b382db12e0ea0d117238763737c76'
        records.append({'name': package['name'], 'version': package['version'], 'license': license_id, 'source': source_url, 'repository': package.get('repository'), 'authors': package.get('authors', [])})
        entries.append(f"{package['name']} {package['version']} | {license_id} | {source_url}")
    if args.inventory:
        Path(args.inventory).write_text(json.dumps({'schemaVersion': 1, 'target': args.target, 'rootPackage': 'livekit-uniffi', 'scope': 'Normal and build dependency closure; excludes unrelated workspace packages and development dependencies.', 'packages': sorted(records, key=lambda p: (p['name'], p['version']))}, indent=2) + '\n')
    output = Path(args.output)
    output.write_text('Native framework dependency notices\n\n' + '\n'.join(sorted(entries)) + '\n\n' + '\n\n'.join(texts.values()))


if __name__ == '__main__':
    main()

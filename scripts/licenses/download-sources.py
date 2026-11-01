#!/usr/bin/env python3
"""Download and reassemble a release source kit without executing its contents."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

def safe_name(name):
    return isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', name) and '..' not in name

def download(manifest_url, output):
    parsed = urllib.parse.urlparse(manifest_url)
    if parsed.scheme != 'https' or parsed.username or parsed.password or not parsed.path.endswith('/sources/manifest.json'):
        raise ValueError('Use the HTTPS source manifest linked from the release licenses')
    with urllib.request.urlopen(manifest_url, timeout=90) as response:
        data = response.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError('Source manifest is too large')
    manifest = json.loads(data)
    if manifest.get('schemaVersion') != 1 or not 1 <= len(manifest.get('files', [])) <= 256:
        raise ValueError('Invalid source manifest')
    if output.is_symlink() or (output.exists() and (not output.is_dir() or any(output.iterdir()))):
        raise ValueError('Use a new or empty output directory; existing files are never replaced')
    if not isinstance(manifest.get('materials'), list) or not manifest['materials']:
        raise ValueError('Missing source materials')
    names, archives, used = set(), set(), set()
    for record in manifest['files']:
        name, size = record['fileName'], record['sizeBytes']
        if (not safe_name(name) or name == 'manifest.json' or name in names
                or type(size) is not int or not 0 < size <= 64 * 1024 * 1024
                or not re.fullmatch(r'[a-f0-9]{64}', record['sha256'])):
            raise ValueError('Invalid source part')
        names.add(name)
    for material in manifest['materials']:
        name = material['archiveName']
        if (not safe_name(name) or name == 'manifest.json' or name in names or name in archives
                or not re.fullmatch(r'[a-f0-9]{64}', material['sha256']) or not material['files']):
            raise ValueError('Invalid source archive')
        archives.add(name)
        for part in material['files']:
            if part not in names or part in used:
                raise ValueError('Missing or reused source part')
            used.add(part)
    if names != used:
        raise ValueError('Unreferenced source part')
    output.mkdir(parents=True, exist_ok=True)
    files = {}
    for record in manifest['files']:
        name, size = record['fileName'], record['sizeBytes']
        if not safe_name(name) or name in files or not isinstance(size, int) or not 0 < size <= 64 * 1024 * 1024:
            raise ValueError('Invalid source part')
        path = output / name
        if path.is_symlink():raise ValueError('Refusing a symlink output')
        with urllib.request.urlopen(urllib.parse.urljoin(manifest_url, name), timeout=180) as response:
            part = response.read(size + 1)
        if len(part) != size or hashlib.sha256(part).hexdigest() != record['sha256']:
            raise ValueError('Source part checksum mismatch')
        with path.open('xb') as stream:stream.write(part)
        files[name] = path
    for material in manifest['materials']:
        name = material['archiveName']
        if not safe_name(name) or (output / name).is_symlink():raise ValueError('Unsafe source archive name')
        checksum = hashlib.sha256()
        with (output / name).open('xb') as stream:
            for part in material['files']:
                if part not in files:raise ValueError('Missing source part')
                data = files[part].read_bytes(); stream.write(data); checksum.update(data)
        if checksum.hexdigest() != material['sha256']:
            raise ValueError('Reassembled source checksum mismatch')
    with (output / 'manifest.json').open('x') as stream:
        stream.write(json.dumps(manifest, indent=2) + '\n')
    print('Downloaded and verified all source archives. No archive code was executed.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    download(args.manifest, Path(args.output))

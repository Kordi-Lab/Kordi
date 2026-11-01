#!/usr/bin/env python3
"""Collect exact-version public licensing evidence; never execute dependency code.

Requires Python 3.11+, Node, installed pnpm dependencies, Cargo and Go. The
result is reviewed compliance data, not a claim that every locked package ships.
Run from any directory. Network responses are cached outside the tracked tree.
"""
import base64
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import shutil
import tomllib
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(os.environ.get('KORDI_LICENSE_CACHE', str(ROOT / '.build/license-cache')))
CACHE.mkdir(parents=True, exist_ok=True)
LICENSE_NAME = re.compile(r'^(licen[sc]e|copying|copyright|notice|third.party.notices)([._-]|$)', re.I)
ALLOWED = {'MIT', 'MIT-0', 'Apache-2.0', 'ISC', 'BSD-1-Clause', 'BSD-2-Clause',
           'BSD-3-Clause', '0BSD', 'Zlib', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0',
           'MPL-2.0', 'LGPL-3.0-or-later', 'LGPL-2.1-or-later', 'LGPL-2.1-only', 'LGPL-2.0-only',
           'Unicode-3.0', 'CDLA-Permissive-2.0', 'BSL-1.0', 'BlueOak-1.0.0',
           'Python-2.0', 'WTFPL', 'LLVM-exception'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def get(url):
    parsed = urllib.parse.urlparse(url)
    allowed_hosts = {'registry.npmjs.org', 'registry.npmmirror.com', 'static.crates.io',
                     'raw.githubusercontent.com', 'codeload.github.com', 'proxy.golang.org'}
    if parsed.scheme != 'https' or parsed.hostname not in allowed_hosts:
        raise ValueError('Unapproved public license source: ' + url)
    file = CACHE / digest(url.encode())
    if file.exists():
        return file.read_bytes()
    request = urllib.request.Request(url, headers={'User-Agent': 'Kordi-license-collector/1'})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read()
    with tempfile.NamedTemporaryFile(dir=CACHE, delete=False) as temporary:
        temporary.write(data)
        name = temporary.name
    Path(name).replace(file)
    return data


def command(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True)


def spdx_ids(expression):
    # Older Cargo metadata uses slash for OR. AND is preserved in the inventory.
    tokens = re.findall(r'[A-Za-z0-9][A-Za-z0-9.+-]*', expression.replace('/', ' OR '))
    ids = set(tokens) - {'AND', 'OR', 'WITH'}
    unknown = ids - ALLOWED
    if unknown:
        raise ValueError('License requires review: ' + ', '.join(sorted(unknown)))
    return sorted(ids)


def archive_notices(data):
    notices = []
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for entry in archive:
            if entry.isfile() and LICENSE_NAME.match(Path(entry.name).name):
                if entry.size > 8_000_000:
                    raise ValueError('Unexpectedly large notice: ' + entry.name)
                notices.append((entry.name, archive.extractfile(entry).read().decode('utf-8', 'replace')))
    return sorted(notices)


def local_notices(directory):
    return sorted((str(p.relative_to(directory)), p.read_text(errors='replace'))
                  for p in directory.rglob('*') if p.is_file() and LICENSE_NAME.match(p.name))


def record(ecosystem, name, version, license_id, source, notices, authors=None):
    spdx_ids(license_id)
    return {'ecosystem': ecosystem, 'name': name, 'version': version,
            'license': license_id, 'source': source, 'notices': notices,
            'authors': authors or [],
            'evidence': 'upstream-notices' if notices else 'manifest-and-canonical-license'}


def npm_package(row):
    identity = row['name'] + '@' + row['version']
    metadata = json.loads(get('https://registry.npmjs.org/' + urllib.parse.quote(row['name'], safe='') + '/' + row['version']))
    license_id = metadata.get('license')
    if not isinstance(license_id, str):
        raise ValueError('Missing npm license: ' + identity)
    spdx_ids(license_id)
    url = metadata['dist']['tarball']
    data = get(url)
    integrity = row.get('integrity')
    if not isinstance(integrity, str) or '-' not in integrity:
        raise ValueError('Missing locked integrity: ' + identity)
    algorithm, expected = integrity.split('-', 1)
    if base64.b64encode(hashlib.new(algorithm, data).digest()).decode() != expected:
        raise ValueError('Lock integrity mismatch: ' + identity)
    authors = [metadata['author']] if isinstance(metadata.get('author'), str) else []
    result = record('+'.join(row['ecosystems']), row['name'], row['version'], license_id, url, archive_notices(data), authors)
    result['integrity'] = integrity
    return result


def rust_packages():
    metadata = json.loads(command('cargo', 'metadata', '--locked', '--format-version', '1'))
    result = []
    for package in metadata['packages']:
        if not package['source']:
            continue
        directory = Path(package['manifest_path']).parent
        notices = local_notices(directory)
        license_id = package['license']
        if package['name'] == 'dicebear-styles' and not license_id:
            # The license file enumerates all artwork styles; do not relicense them.
            license_id = 'CC0-1.0'
            selected = [item for item in notices if item[0] == 'LICENSE.md']
            if not selected or '## Lorelei' not in selected[0][1]:
                raise ValueError('Review DiceBear artwork license changes')
        if not license_id:
            raise ValueError('Missing Rust license: ' + package['name'])
        source = f"https://static.crates.io/crates/{package['name']}/{package['name']}-{package['version']}.crate"
        result.append(record('cargo', package['name'], package['version'], license_id,
                             source, notices, package.get('authors')))
        if package['name'] == 'dicebear-styles':
            result[-1]['scope'] = 'CC0 applies to selected Lorelei artwork only; other bundled styles retain LICENSE.md terms.'
    return result


def decode_stream(text):
    decoder = json.JSONDecoder()
    while text.strip():
        value, length = decoder.raw_decode(text.lstrip())
        yield value
        text = text.lstrip()[length:]


def go_packages():
    temporary = tempfile.TemporaryDirectory(prefix='kordi-go-licenses-')
    directory = Path(temporary.name)
    for name in ['go.mod', 'go.sum']:
        shutil.copyfile(ROOT / 'bridges/cloud-temporal-bridge' / name, directory / name)
    command('go', 'mod', 'download', 'all', cwd=directory)
    result = []
    for module in decode_stream(command('go', 'list', '-m', '-json', 'all', cwd=directory)):
        if module.get('Main'):
            continue
        notices = local_notices(Path(module['Dir']))
        text = '\n'.join(content for _, content in notices)
        if 'Apache License' in text:
            license_id = 'Apache-2.0'
        elif 'Permission is hereby granted, free of charge' in text:
            license_id = 'MIT'
        elif 'ISC License' in text:
            license_id = 'ISC'
        elif re.search('neither the names?', text, re.I):
            license_id = 'BSD-3-Clause'
        elif 'Redistribution and use in source and binary' in text:
            license_id = 'BSD-2-Clause'
        else:
            raise ValueError('Review Go license: ' + module['Path'])
        path = ''.join('!' + c.lower() if c.isupper() else c for c in module['Path'])
        result.append(record('go', module['Path'], module['Version'], license_id,
                             f"https://proxy.golang.org/{path}/@v/{module['Version']}.zip", notices))
    temporary.cleanup()
    return result


def swift_packages():
    pins = json.loads((ROOT / 'app/ios/Kordi.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved').read_text())['pins']
    licenses = {'client-sdk-swift': 'Apache-2.0', 'livekit-uniffi-xcframework': 'Apache-2.0',
                'swift-protobuf': 'Apache-2.0', 'webrtc-xcframework': 'MIT'}
    result = []
    for pin in pins:
        repository = pin['location'].removeprefix('https://github.com/').removesuffix('.git')
        url = f"https://codeload.github.com/{repository}/tar.gz/{pin['state']['revision']}"
        notices = archive_notices(get(url))
        if not notices:
            raise ValueError('Missing Swift notices: ' + pin['identity'])
        result.append(record('swift', pin['identity'], pin['state']['version'], licenses[pin['identity']], url, notices))
        result[-1]['revision'] = pin['state']['revision']
        if pin['identity'] == 'swift-protobuf':
            result[-1]['scope'] = 'Includes the upstream Runtime Library Exception; see original license text.'
        if pin['identity'] in {'livekit-uniffi-xcframework', 'webrtc-xcframework'}:
            result[-1]['scope'] = 'Package wrapper. Binary internals require the separate native release evidence.'
    return result


def main():
    rows = json.loads(command('node', 'scripts/licenses/locked.mjs'))
    print(f'Collecting {len(rows)} exact npm archives', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        packages = list(pool.map(npm_package, rows))
    packages += rust_packages() + go_packages() + swift_packages()
    runtime = json.loads((ROOT / 'shared/omp-runtime/package.json').read_text())['packageManager'].removeprefix('bun@')
    bun_url = f'https://raw.githubusercontent.com/oven-sh/bun/bun-v{runtime}/LICENSE.md'
    packages.append(record('runtime', 'Bun', runtime, 'MIT AND LGPL-2.0-only AND LGPL-2.1-only',
                           f'https://codeload.github.com/oven-sh/bun/tar.gz/refs/tags/bun-v{runtime}',
                           [('LICENSE.md', get(bun_url).decode())]))
    # Standard texts supplement original notices; they never replace them.
    ids = sorted({identifier for package in packages for identifier in spdx_ids(package['license'])})
    standard = {}
    for identifier in ids:
        folder = 'text'
        url = f'https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/{folder}/{identifier}.txt'
        standard[identifier] = get(url).decode()
    documents = {}
    for package in packages:
        links = []
        for filename, text in package.pop('notices'):
            key = digest(text.encode())
            documents[key] = text
            links.append({'file': filename, 'sha256': key})
        package['notices'] = links
    # Public copyright contacts must remain verbatim; permit only reviewed hashes
    # in the four generated attribution files, never in application/user data.
    corpus = '\n'.join(documents.values()) + '\n' + '\n'.join(a for p in packages for a in p['authors'])
    native_files = sorted((ROOT / 'legal/native').glob('*.txt')) + sorted((ROOT / 'legal/native').glob('*dependencies.json'))
    corpus += '\n' + '\n'.join(p.read_text() for p in native_files)
    emails = {x.lower() for x in re.findall(r'[A-Za-z0-9._%+-]+@(?:gmail|outlook|hotmail|icloud|qq|163)\.com', corpus, re.I)}
    (ROOT / 'legal/public-contact-hashes.json').write_text(json.dumps(sorted(digest(x.encode()) for x in emails), indent=2) + '\n')
    paths = ['Cargo.lock', 'pnpm-lock.yaml', 'shared/omp-runtime/bun.lock',
             'bridges/cloud-temporal-bridge/go.mod', 'bridges/cloud-temporal-bridge/go.sum',
             'app/ios/Kordi.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
             'shared/omp-runtime/package.json', 'legal/runtime-sources.json', 'legal/native/archive-evidence.json', 'legal/public-contact-hashes.json']
    paths += ['app/desktop/package.json', 'legal/runtime-relink-verification.json', 'legal/runtime-bundle-review.json']
    paths += [str(p.relative_to(ROOT)) for p in sorted((ROOT / 'legal/native').iterdir()) if p.is_file() and str(p.relative_to(ROOT)) not in paths]
    paths += [str(p.relative_to(ROOT)) for p in sorted((ROOT / 'legal/runtime-patches').glob('*.patch'))]
    catalog = {'schemaVersion': 1, 'scope': 'Conservative lock inventory, including build, test and optional dependencies; not a shipped-code SBOM.',
               'inputs': {path: digest((ROOT / path).read_bytes()) for path in paths},
               'packages': sorted(packages, key=lambda x: (x['ecosystem'], x['name'], x['version'])),
               'standardLicenses': standard, 'documents': dict(sorted(documents.items()))}
    destination = ROOT / 'legal/catalog.json'
    destination.write_text(json.dumps(catalog, ensure_ascii=True, indent=2) + '\n')
    print(f'Saved {len(packages)} components and {len(documents)} original notice texts. Review before accepting lock changes.', flush=True)


if __name__ == '__main__':
    main()

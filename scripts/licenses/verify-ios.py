#!/usr/bin/env python3
"""Reject iOS releases with unreviewed framework bytes or missing notices."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from macho_sections import section_digest

ROOT = Path(__file__).resolve().parents[2]

def verify(app, platform):
    subprocess.run(['node', str(ROOT / 'scripts/licenses.mjs'), 'verify', str(app / 'licenses')], check=True)
    evidence = json.loads((ROOT / 'legal/native/binary-section-hashes.json').read_text())
    actual = {p.stem for p in (app / 'Frameworks').glob('*.framework')}
    if actual != set(evidence['frameworks']):
        raise RuntimeError('The native framework inventory has changed; review its licenses before release')
    for name, record in evidence['frameworks'].items():
        expected = record['platforms'].get(platform)
        if not expected:
            raise RuntimeError('No reviewed framework for this target: ' + name)
        binary = app / 'Frameworks' / (name + '.framework') / name
        if not binary.resolve().is_relative_to(app.resolve()) or section_digest(binary.read_bytes()) != expected:
            raise RuntimeError('Unreviewed native framework contents: ' + name)
    print('iOS framework identity and bundled license verification passed.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True)
    parser.add_argument('--platform', default='ios-arm64')
    args = parser.parse_args()
    verify(Path(args.app), args.platform)
